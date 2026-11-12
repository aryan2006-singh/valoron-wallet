import { isNonEmptyString, isUuid, jsonError, parseAmountPaise, readJsonObject, requireUser, runUserRpc } from "@/lib/api-helpers";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const body = await readJsonObject(request, ["recipientId", "amountPaise", "idempotencyKey"]);
  const amount = parseAmountPaise(body?.amountPaise);
  if (!body || !isUuid(body.recipientId) || amount === null || !isNonEmptyString(body.idempotencyKey, 200)) {
    return jsonError("INVALID_INPUT", 400);
  }

  return runUserRpc({
    request,
    supabase: auth.supabase,
    userId: auth.user.id,
    rpc: "send_support",
    args: {
      p_sender_id: auth.user.id,
      p_recipient_id: body.recipientId,
      p_amount_paise: amount,
      p_idempotency_key: body.idempotencyKey,
    },
    targetId: body.recipientId,
    auditDetail: { amountPaise: amount },
    respond: (data) => ({ transactionId: data }),
  });
}
