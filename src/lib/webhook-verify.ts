import { createHmac, timingSafeEqual } from "crypto";

// Verifies an HMAC-SHA256 signature over the RAW request body. Must be
// called with the exact bytes the sender signed -- never a re-serialized
// JSON.stringify(parsed body), which can differ in whitespace/key order and
// would make every signature check fail (or, worse, be "fixed" by skipping
// verification).
export function verifySignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

export function isWithinReplayWindow(timestampSeconds: number, windowSeconds: number): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - timestampSeconds) <= windowSeconds;
}
