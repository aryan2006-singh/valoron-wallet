import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getClientIp,
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isUuid,
  logAttempt,
  mapPostgresError,
  parseAmountPaise,
} from "@/lib/api-helpers";

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !hasOnlyAllowedKeys(body as Record<string, unknown>, ["recipientId", "amountPaise", "idempotencyKey"])
  ) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { recipientId, amountPaise, idempotencyKey } = body as Record<string, unknown>;
  const amount = parseAmountPaise(amountPaise);

  if (!isUuid(recipientId) || amount === null || !isNonEmptyString(idempotencyKey, 200)) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("send_support", {
    p_sender_id: user.id,
    p_recipient_id: recipientId,
    p_amount_paise: amount,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    const mapped = mapPostgresError(error);
    await logAttempt({
      actorId: user.id,
      action: "send_support",
      targetId: recipientId,
      ip,
      result: "rejected",
      detail: { amountPaise: amount, code: mapped.code },
    });
    return NextResponse.json({ code: mapped.code }, { status: mapped.status });
  }

  return NextResponse.json({ transactionId: data });
}
