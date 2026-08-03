import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getClientIp, hasOnlyAllowedKeys, logAttempt, mapPostgresError, parseAmountPaise } from "@/lib/api-helpers";

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
    !hasOnlyAllowedKeys(body as Record<string, unknown>, ["amountPaise"])
  ) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const amount = parseAmountPaise((body as Record<string, unknown>).amountPaise);
  if (amount === null) {
    return NextResponse.json({ code: "INVALID_INPUT" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("create_deposit_intent", {
    p_amount_paise: amount,
  });

  if (error) {
    const mapped = mapPostgresError(error);
    await logAttempt({
      actorId: user.id,
      action: "create_deposit_intent",
      ip,
      result: "rejected",
      detail: { amountPaise: amount, code: mapped.code },
    });
    return NextResponse.json({ code: mapped.code }, { status: mapped.status });
  }

  return NextResponse.json({ intentId: data, amountPaise: amount });
}
