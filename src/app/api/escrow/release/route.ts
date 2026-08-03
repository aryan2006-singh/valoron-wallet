import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getClientIp,
  hasOnlyAllowedKeys,
  isNonEmptyString,
  isUuid,
  logAttempt,
  mapPostgresError,
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
    !hasOnlyAllowedKeys(body as Record<string, unknown>, ["holdId", "idempotencyKey"])
  ) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { holdId, idempotencyKey } = body as Record<string, unknown>;
  if (!isUuid(holdId) || !isNonEmptyString(idempotencyKey, 200)) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("release_escrow", {
    p_caller_id: user.id,
    p_hold_id: holdId,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    const mapped = mapPostgresError(error);
    await logAttempt({
      actorId: user.id,
      action: "release_escrow",
      targetId: holdId,
      ip,
      result: "rejected",
      detail: { code: mapped.code },
    });
    return NextResponse.json({ code: mapped.code }, { status: mapped.status });
  }

  return NextResponse.json({ transactionId: data });
}
