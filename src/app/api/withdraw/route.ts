import { isNonEmptyString, jsonError, parseAmountPaise, readJsonObject, requireUser, runUserRpc } from "@/lib/api-helpers";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const body = await readJsonObject(request, ["amountPaise", "destination", "idempotencyKey"]);
  const amount = parseAmountPaise(body?.amountPaise);
  const destination = typeof body?.destination === "string" ? body.destination.trim() : null;
  if (!body || amount === null || !isNonEmptyString(destination, 200) || !isNonEmptyString(body.idempotencyKey, 200)) {
    return jsonError("INVALID_INPUT", 400);
  }

  return runUserRpc({
    request,
    supabase: auth.supabase,
    userId: auth.user.id,
    rpc: "request_withdrawal",
    args: {
      p_caller_id: auth.user.id,
      p_amount_paise: amount,
      p_destination: destination,
      p_idempotency_key: body.idempotencyKey,
    },
    auditDetail: { amountPaise: amount },
    respond: (data) => ({ transactionId: data }),
  });
}
