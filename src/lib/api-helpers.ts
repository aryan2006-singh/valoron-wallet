import { NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "./supabase/server";
import { createServiceClient } from "./supabase/service";

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

const ERROR_MAP: Record<string, { status: number; code: string }> = {
  P1001: { status: 402, code: "INSUFFICIENT_FUNDS" },
  P1002: { status: 403, code: "UNAUTHORIZED" },
  P1003: { status: 409, code: "INVALID_STATUS" },
  P1004: { status: 404, code: "NOT_FOUND" },
  P1005: { status: 400, code: "INVALID_INPUT" },
  P1006: { status: 429, code: "RATE_LIMITED" },
  P1007: { status: 409, code: "IDEMPOTENCY_CONFLICT" },
};

// Maps a Postgres error (surfaced through supabase-js as error.code, which
// carries the SQLSTATE we raised in each function) to a clean HTTP response.
// Never forwards the raw Postgres message to the client -- only our own
// short, fixed machine-readable code.
export function mapPostgresError(error: { code?: string; message?: string } | null | undefined): {
  status: number;
  code: string;
} {
  const mapped = error?.code ? ERROR_MAP[error.code] : undefined;
  if (!mapped) {
    // Unexpected failure: keep the client response generic, but make sure
    // the real cause reaches the server logs so a 500 is debuggable.
    console.error("Unmapped database error", { code: error?.code, message: error?.message });
    return { status: 500, code: "INTERNAL_ERROR" };
  }
  return mapped;
}

export async function logAttempt(params: {
  actorId: string | null;
  action: string;
  targetId?: string | null;
  ip: string;
  result: "success" | "rejected";
  detail: Record<string, unknown>;
}) {
  const service = createServiceClient();
  const { error } = await service.from("audit_log").insert({
    actor_id: params.actorId,
    action: params.action,
    target_id: params.targetId ?? null,
    ip: params.ip,
    result: params.result,
    detail: params.detail,
  });
  if (error) console.error("Failed to write audit_log", { action: params.action, code: error.code });
}

// Strict integer-paise validator: rejects floats, negative/zero amounts,
// numbers-as-strings, and absurdly large values before anything touches the
// database.
export function parseAmountPaise(value: unknown, max = 100_000_00000): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value)) return null;
  if (value <= 0) return null;
  if (value > max) return null;
  return value;
}

export function isNonEmptyString(value: unknown, maxLen = 500): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

// Rejects request bodies containing any key not in the allowed list -- an
// unexpected extra field is treated as invalid input, not silently ignored.
export function hasOnlyAllowedKeys(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

export function jsonError(code: string, status: number) {
  return NextResponse.json({ code }, { status });
}

// Resolves the calling user from the session cookie. Returns a ready-made
// 401 response when there is no session, so routes can early-return it.
export async function requireUser(): Promise<
  { ok: true; supabase: SupabaseClient; user: User } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: jsonError("UNAUTHENTICATED", 401) };
  return { ok: true, supabase, user };
}

// Parses the request body as a JSON object containing only `allowed` keys.
// Returns null for malformed JSON, non-objects, arrays, or unexpected keys.
export async function readJsonObject(
  request: Request,
  allowed: string[]
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return hasOnlyAllowedKeys(record, allowed) ? record : null;
}

// Calls a money RPC as the logged-in user and turns the result into an HTTP
// response, writing an audit_log row for any rejection.
export async function runUserRpc(params: {
  request: Request;
  supabase: SupabaseClient;
  userId: string;
  rpc: string;
  args: Record<string, unknown>;
  targetId?: string | null;
  auditDetail?: Record<string, unknown>;
  respond: (data: unknown) => Record<string, unknown>;
}) {
  const { data, error } = await params.supabase.rpc(params.rpc, params.args);
  if (error) {
    const mapped = mapPostgresError(error);
    await logAttempt({
      actorId: params.userId,
      action: params.rpc,
      targetId: params.targetId ?? null,
      ip: getClientIp(params.request),
      result: "rejected",
      detail: { ...params.auditDetail, code: mapped.code },
    });
    return jsonError(mapped.code, mapped.status);
  }
  return NextResponse.json(params.respond(data));
}

// Webhook secrets must be present and long enough to be unguessable. An
// unset or empty secret would otherwise either crash every request or --
// worse -- make HMAC signatures trivially forgeable.
export function getWebhookSecret(name: "PAYMENT_WEBHOOK_SECRET" | "PAYOUT_WEBHOOK_SECRET"): string | null {
  const value = process.env[name];
  if (!value || value.length < 32) {
    console.error(`${name} is missing or shorter than 32 characters; rejecting webhook`);
    return null;
  }
  return value;
}
