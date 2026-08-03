import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getClientIp, logAttempt, mapPostgresError } from "@/lib/api-helpers";
import { isWithinReplayWindow, verifySignature } from "@/lib/webhook-verify";

// Public endpoint, signature-authenticated, same as /api/webhooks/payment.
// This is the ONLY code path that can call settle_withdrawal / fail_withdrawal
// -- both are granted to service_role alone, so even a user who discovers
// this URL and a request_id cannot settle their own withdrawal without also
// forging a valid HMAC signature, which requires a secret only this server
// process holds.
const REPLAY_WINDOW_SECONDS = 300;

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rawBody = await request.text();
  const signature = request.headers.get("x-signature");
  const secret = process.env.PAYOUT_WEBHOOK_SECRET!;

  if (!verifySignature(rawBody, signature, secret)) {
    await logAttempt({ actorId: null, action: "webhook_payout", ip, result: "rejected", detail: { reason: "bad_signature" } });
    return NextResponse.json({ code: "INVALID_SIGNATURE" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { event, request_id, payout_id, reason, timestamp } = payload as Record<string, unknown>;

  if (
    (event !== "payout.settled" && event !== "payout.failed") ||
    typeof request_id !== "string" ||
    typeof payout_id !== "string" ||
    typeof timestamp !== "number"
  ) {
    await logAttempt({ actorId: null, action: "webhook_payout", ip, result: "rejected", detail: { reason: "bad_shape" } });
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  if (!isWithinReplayWindow(timestamp, REPLAY_WINDOW_SECONDS)) {
    await logAttempt({ actorId: null, action: "webhook_payout", ip, result: "rejected", detail: { reason: "stale_timestamp" } });
    return NextResponse.json({ code: "STALE_TIMESTAMP" }, { status: 401 });
  }

  const service = createServiceClient();
  const isSettled = event === "payout.settled";
  const rpcName = isSettled ? "settle_withdrawal" : "fail_withdrawal";
  const rpcArgs = isSettled
    ? { p_request_id: request_id, p_idempotency_key: payout_id }
    : {
        p_request_id: request_id,
        p_reason: typeof reason === "string" ? reason : "unspecified",
        p_idempotency_key: payout_id,
      };

  const { data: transactionId, error } = await service.rpc(rpcName, rpcArgs);

  if (error) {
    const mapped = mapPostgresError(error);
    await logAttempt({ actorId: null, action: rpcName, targetId: request_id, ip, result: "rejected", detail: { code: mapped.code } });
    return NextResponse.json({ code: mapped.code }, { status: mapped.status });
  }

  await logAttempt({
    actorId: null,
    action: rpcName,
    targetId: request_id,
    ip,
    result: "success",
    detail: { transactionId, payout_id },
  });

  return NextResponse.json({ received: true, transactionId });
}
