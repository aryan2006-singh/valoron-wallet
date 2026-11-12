const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Formats paise as rupees, e.g. 123456 -> "₹1,234.56", -5000 -> "−₹50.00". */
export function formatRupees(paise: number, { signed = false }: { signed?: boolean } = {}) {
  const abs = inr.format(Math.abs(paise) / 100);
  if (paise < 0) return `−${abs}`;
  if (signed && paise > 0) return `+${abs}`;
  return abs;
}

/** Parses a rupee string typed by the user into paise; null if not a positive amount. */
export function toPaise(rupeeStr: string): number | null {
  const value = Number(rupeeStr.replace(/,/g, "").trim());
  if (!rupeeStr.trim() || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

const ENTRY_LABELS: Record<string, string> = {
  deposit: "Money added",
  support_send: "Support sent",
  support_receive: "Support received",
  support_fee: "Platform fee",
  platform_fee: "Platform fee",
  escrow_fund: "Escrow funded",
  escrow_release: "Escrow released",
  escrow_refund: "Escrow refunded",
  withdrawal_request: "Withdrawal requested",
  withdrawal_settle: "Withdrawal settled",
  withdrawal_fail: "Withdrawal failed",
};

export function entryLabel(entryType: string) {
  if (ENTRY_LABELS[entryType]) return ENTRY_LABELS[entryType];
  const words = entryType.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDate(iso: string) {
  return dateFmt.format(new Date(iso));
}

const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Your session expired. Please sign in again.",
  INVALID_INPUT: "That doesn't look right. Check the amount and try again.",
  INSUFFICIENT_FUNDS: "You don't have enough available balance for that.",
  UNAUTHORIZED: "You're not allowed to do that.",
  INVALID_STATUS: "That escrow has already been settled.",
  NOT_FOUND: "We couldn't find that item.",
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
  IDEMPOTENCY_CONFLICT: "This request was already submitted.",
  INTERNAL_ERROR: "Something went wrong on our side. Please try again.",
};

export function friendlyError(code: string) {
  return ERROR_MESSAGES[code] ?? `Something went wrong (${code}).`;
}
