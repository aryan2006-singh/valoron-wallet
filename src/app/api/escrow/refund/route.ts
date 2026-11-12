import { isNonEmptyString, isUuid, jsonError, readJsonObject, requireUser, runUserRpc } from "@/lib/api-helpers";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  const body = await readJsonObject(request, ["holdId", "idempotencyKey"]);
  if (!body || !isUuid(body.holdId) || !isNonEmptyString(body.idempotencyKey, 200)) {
    return jsonError("INVALID_INPUT", 400);
  }

  return runUserRpc({
    request,
    supabase: auth.supabase,
    userId: auth.user.id,
    rpc: "refund_escrow",
    args: {
      p_caller_id: auth.user.id,
      p_hold_id: body.holdId,
      p_idempotency_key: body.idempotencyKey,
    },
    targetId: body.holdId,
    respond: (data) => ({ transactionId: data }),
  });
}
