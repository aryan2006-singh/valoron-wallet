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
};

// Maps a Postgres error (surfaced through supabase-js as error.code, which
// carries the SQLSTATE we raised in each function) to a clean HTTP response.
// Never forwards the raw Postgres message to the client -- only our own
// short, fixed machine-readable code.
export function mapPostgresError(error: { code?: string } | null | undefined): {
  status: number;
  code: string;
} {
  const mapped = error?.code ? ERROR_MAP[error.code] : undefined;
  return mapped ?? { status: 500, code: "INTERNAL_ERROR" };
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
  await service.from("audit_log").insert({
    actor_id: params.actorId,
    action: params.action,
    target_id: params.targetId ?? null,
    ip: params.ip,
    result: params.result,
    detail: params.detail,
  });
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
