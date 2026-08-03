import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getClientIp,
  hasOnlyAllowedKeys,
  isNonEmptyString,
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
    !hasOnlyAllowedKeys(body as Record<string, unknown>, ["amountPaise", "destination", "idempotencyKey"])
  ) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { amountPaise, destination, idempotencyKey } = body as Record<string, unknown>;
  const amount = parseAmountPaise(amountPaise);

  if (!isNonEmptyString(destination, 200) || amount === null || !isNonEmptyString(idempotencyKey, 200)) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("request_withdrawal", {
    p_caller_id: user.id,
    p_amount_paise: amount,
    p_destination: destination,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    const mapped = mapPostgresError(error);
    await logAttempt({
      actorId: user.id,
      action: "request_withdrawal",
      ip,
      result: "rejected",
      detail: { amountPaise: amount, code: mapped.code },
    });
    return NextResponse.json({ code: mapped.code }, { status: mapped.status });
  }

  return NextResponse.json({ transactionId: data });
}
