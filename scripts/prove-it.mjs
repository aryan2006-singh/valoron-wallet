// Fires the required webhook/withdrawal test scenarios (spec section 4.5)
// against a running local stack (`supabase start` + `npm run dev`) and
// prints PASS/FAIL for each. Run with: node scripts/prove-it.mjs
//
// Tests 1-5 hit our actual /api/webhooks/payment route over HTTP, exactly as
// a real payment provider would. Tests 6-8 call the Postgres RPC functions
// directly with a real logged-in user's JWT (rather than going through our
// Next.js /api routes), to avoid needing to simulate a browser cookie
// session from a plain script -- this still exercises the actual security
// enforcement (RLS, auth.uid() ownership checks, EXECUTE grants), which is
// where the real guarantees live; the Next.js layer only adds input
// validation and HTTP status mapping on top.

import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return env;
}

const env = loadEnv(path.join(__dirname, "..", ".env.local"));
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE_KEY = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = env.SUPABASE_SECRET_KEY;
const PAYMENT_SECRET = env.PAYMENT_WEBHOOK_SECRET;
const APP_URL = "http://localhost:3000";

let passCount = 0;
let failCount = 0;

function report(name, expected, pass, detail) {
  const status = pass ? "PASS" : "FAIL";
  if (pass) passCount++;
  else failCount++;
  console.log(`[${status}] ${name}`);
  console.log(`       expected: ${expected}`);
  if (detail) console.log(`       detail:   ${detail}`);
}

function sign(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function postWebhook(body, signature) {
  const headers = { "Content-Type": "application/json" };
  if (signature !== null) headers["X-Signature"] = signature;
  const res = await fetch(`${APP_URL}/api/webhooks/payment`, { method: "POST", headers, body });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

async function createTestUser(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`createTestUser failed: ${JSON.stringify(json)}`);
  return json.id;
}

async function login(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`login failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function rpc(fnName, args, token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

async function getAvailableBalance(token) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/my_balances?account_type=eq.available&select=balance_paise`, {
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return json[0]?.balance_paise ?? 0;
}

async function main() {
  console.log("=== Valoron Wallet proof script ===\n");

  const stamp = Date.now();
  const password = "ProveIt123!aA";
  const email = `prove-it-${stamp}@valoron.test`;
  const userId = await createTestUser(email, password);
  const token = await login(email, password);
  const recipientEmail = `prove-it-recipient-${stamp}@valoron.test`;
  const recipientId = await createTestUser(recipientEmail, password);
  console.log(`Created test users ${email} and ${recipientEmail}\n`);

  // --- 1. Valid deposit webhook -> credited once ---
  const { json: intent1 } = await rpc("create_deposit_intent", { p_amount_paise: 100000 }, token);
  const payload1 = JSON.stringify({
    event: "payment.captured",
    payment_id: `pay_${crypto.randomUUID()}`,
    intent_id: intent1,
    amount_paise: 100000,
    timestamp: Math.floor(Date.now() / 1000),
  });
  const sig1 = sign(PAYMENT_SECRET, payload1);
  const balanceBeforeDeposit = await getAvailableBalance(token);
  const res1 = await postWebhook(payload1, sig1);
  const balanceAfterDeposit = await getAvailableBalance(token);
  report(
    "1. Valid deposit webhook",
    "credited once",
    res1.status === 200 && balanceAfterDeposit - balanceBeforeDeposit === 100000,
    `status=${res1.status}, balance ${balanceBeforeDeposit} -> ${balanceAfterDeposit}`
  );

  // --- 2. Same webhook, 20x in parallel -> credited once total ---
  const parallel = await Promise.all(Array.from({ length: 20 }, () => postWebhook(payload1, sig1)));
  const balanceAfterParallel = await getAvailableBalance(token);
  report(
    "2. Same webhook, 20x in parallel",
    "credited once total",
    balanceAfterParallel === balanceAfterDeposit,
    `balance stayed at ${balanceAfterParallel}, statuses=[${parallel.map((r) => r.status).join(",")}]`
  );

  // --- 3. Tampered amount_paise, original signature -> rejected ---
  const tampered = JSON.stringify({ ...JSON.parse(payload1), amount_paise: 99999999 });
  const res3 = await postWebhook(tampered, sig1); // sig1 was computed over the ORIGINAL body
  report("3. Tampered amount_paise, original signature", "rejected", res3.status === 401, `status=${res3.status}, body=${JSON.stringify(res3.json)}`);

  // --- 4. Valid signature, timestamp 2 hours old -> rejected ---
  const oldPayload = JSON.stringify({
    event: "payment.captured",
    payment_id: `pay_${crypto.randomUUID()}`,
    intent_id: intent1,
    amount_paise: 100000,
    timestamp: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
  });
  const oldSig = sign(PAYMENT_SECRET, oldPayload);
  const res4 = await postWebhook(oldPayload, oldSig);
  report("4. Valid signature, timestamp 2 hours old", "rejected", res4.status === 401, `status=${res4.status}, body=${JSON.stringify(res4.json)}`);

  // --- 5. No signature header -> rejected ---
  const res5 = await postWebhook(payload1, null);
  report("5. No signature header", "rejected", res5.status === 401, `status=${res5.status}, body=${JSON.stringify(res5.json)}`);

  // --- 6. Withdraw full balance, then immediately send -> payment fails ---
  const balanceBeforeWithdraw = await getAvailableBalance(token);
  const withdrawKey = `withdraw-${crypto.randomUUID()}`;
  const { json: requestId, status: withdrawStatus } = await rpc(
    "request_withdrawal",
    { p_caller_id: userId, p_amount_paise: balanceBeforeWithdraw, p_destination: "test@upi", p_idempotency_key: withdrawKey },
    token
  );
  const { status: sendStatus, json: sendResult } = await rpc(
    "send_support",
    { p_sender_id: userId, p_recipient_id: recipientId, p_amount_paise: 100, p_idempotency_key: `send-${crypto.randomUUID()}` },
    token
  );
  report(
    "6. Withdraw full balance, then immediately send",
    "payment fails -- funds are locked",
    withdrawStatus === 200 && sendResult?.code === "P1001",
    `withdrawStatus=${withdrawStatus}, sendStatus=${sendStatus}, sendBody=${JSON.stringify(sendResult)}`
  );

  // --- 7. Same withdrawal request submitted twice -> one payout, not two ---
  const { status: dupStatus, json: dupResult } = await rpc(
    "request_withdrawal",
    { p_caller_id: userId, p_amount_paise: balanceBeforeWithdraw, p_destination: "test@upi", p_idempotency_key: withdrawKey },
    token
  );
  report(
    "7. Same withdrawal request submitted twice",
    "one payout, not two",
    dupStatus === 200 && dupResult === requestId,
    `first request_id=${requestId}, replay request_id=${dupResult}`
  );

  // --- 8. User attempts to settle their own withdrawal -> rejected ---
  const { status: selfSettleStatus, json: selfSettleResult } = await rpc(
    "settle_withdrawal",
    { p_request_id: requestId, p_idempotency_key: `self-settle-${crypto.randomUUID()}` },
    token
  );
  report(
    "8. User attempts to settle their own withdrawal",
    "rejected",
    selfSettleStatus >= 400,
    `status=${selfSettleStatus}, body=${JSON.stringify(selfSettleResult)}`
  );

  console.log(`\n=== ${passCount} passed, ${failCount} failed ===`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exitCode = 1;
});
