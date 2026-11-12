import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getClientIp, getWebhookSecret, isUuid, logAttempt, mapPostgresError } from "@/lib/api-helpers";
import { isWithinReplayWindow, verifySignature } from "@/lib/webhook-verify";

// Public endpoint -- no session, no auth header. The HMAC signature IS the
// authentication. See SECURITY.md for the full threat walkthrough.
const REPLAY_WINDOW_SECONDS = 300; // 5 minutes

export async function POST(request: Request) {
  const ip = getClientIp(request);

  // Read the raw text FIRST. Verifying a signature over anything other than
  // the exact bytes the provider signed (e.g. a re-serialized JSON.parse
  // result) would make legitimate signatures fail and invite "just skip
  // verification" shortcuts.
  const rawBody = await request.text();
  const signature = request.headers.get("x-signature");
  const secret = getWebhookSecret("PAYMENT_WEBHOOK_SECRET");
  if (!secret) {
    return NextResponse.json({ code: "MISCONFIGURED" }, { status: 500 });
  }

  if (!verifySignature(rawBody, signature, secret)) {
    await logAttempt({
      actorId: null,
      action: "webhook_payment",
      ip,
      result: "rejected",
      detail: { reason: "bad_signature" },
    });
    return NextResponse.json({ code: "INVALID_SIGNATURE" }, { status: 401 });
  }

  // Only parse and trust fields AFTER the signature check passes.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await logAttempt({ actorId: null, action: "webhook_payment", ip, result: "rejected", detail: { reason: "bad_json" } });
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { event, payment_id, intent_id, amount_paise, timestamp } = payload as Record<string, unknown>;

  if (
    event !== "payment.captured" ||
    typeof payment_id !== "string" ||
    payment_id.length === 0 ||
    payment_id.length > 200 ||
    !isUuid(intent_id) ||
    typeof amount_paise !== "number" ||
    typeof timestamp !== "number"
  ) {
    await logAttempt({ actorId: null, action: "webhook_payment", ip, result: "rejected", detail: { reason: "bad_shape" } });
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  if (!isWithinReplayWindow(timestamp, REPLAY_WINDOW_SECONDS)) {
    await logAttempt({ actorId: null, action: "webhook_payment", ip, result: "rejected", detail: { reason: "stale_timestamp" } });
    return NextResponse.json({ code: "STALE_TIMESTAMP" }, { status: 401 });
  }

  const service = createServiceClient();

  // Resolve WHO to credit from our own stored intent, never from a field in
  // the webhook body -- the body only tells us which intent_id the provider
  // is talking about.
  const { data: intent, error: intentError } = await service
    .from("payment_intents")
    .select("id, user_id, amount_paise")
    .eq("id", intent_id)
    .maybeSingle();

  if (intentError || !intent) {
    await logAttempt({
      actorId: null,
      action: "webhook_payment",
      ip,
      result: "rejected",
      detail: { reason: "unknown_intent", intent_id },
    });
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  // We always credit OUR stored intent amount, never the payload's. But a
  // validly signed webhook that disagrees with what we recorded means
  // something is wrong upstream -- reject it loudly rather than paper over it.
  if (amount_paise !== intent.amount_paise) {
    await logAttempt({
      actorId: intent.user_id,
      action: "webhook_payment",
      targetId: intent_id,
      ip,
      result: "rejected",
      detail: { reason: "amount_mismatch", expected: intent.amount_paise, received: amount_paise },
    });
    return NextResponse.json({ code: "AMOUNT_MISMATCH" }, { status: 400 });
  }

  // credit_deposit locks the intent, refuses to credit an intent that is
  // already completed, and marks it completed in the same transaction as
  // the ledger write -- so one intent can never be credited twice, even
  // with different payment_ids.
  const { data: transactionId, error } = await service.rpc("credit_deposit", {
    p_intent_id: intent.id,
    p_provider_payment_id: payment_id,
  });

  if (error) {
    const mapped = mapPostgresError(error);
    await logAttempt({
      actorId: intent.user_id,
      action: "webhook_payment",
      targetId: intent_id,
      ip,
      result: "rejected",
      detail: { code: mapped.code, payment_id },
    });
    return NextResponse.json({ code: mapped.code }, { status: mapped.status });
  }

  await logAttempt({
    actorId: intent.user_id,
    action: "webhook_payment",
    targetId: intent_id,
    ip,
    result: "success",
    detail: { transactionId, payment_id },
  });

  // Only return 2xx now that the credit is durably committed -- a 200
  // returned before this point, followed by a crash, would make the
  // provider stop retrying while the user's money was never actually
  // credited.
  return NextResponse.json({ received: true, transactionId });
}
