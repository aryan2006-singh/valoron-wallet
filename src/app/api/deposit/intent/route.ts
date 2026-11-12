import { jsonError, parseAmountPaise, readJsonObject, requireUser, runUserRpc } from "@/lib/api-helpers";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const body = await readJsonObject(request, ["amountPaise"]);
  const amount = parseAmountPaise(body?.amountPaise);
  if (amount === null) return jsonError("INVALID_INPUT", 400);

  return runUserRpc({
    request,
    supabase: auth.supabase,
    userId: auth.user.id,
    rpc: "create_deposit_intent",
    args: { p_amount_paise: amount },
    auditDetail: { amountPaise: amount },
    respond: (data) => ({ intentId: data, amountPaise: amount }),
  });
}
