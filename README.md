# Valoron Wallet — technical assessment submission

A double-entry wallet ledger built for the Valoron Consulting Full-Stack Engineer assessment: deposit (verified webhook), peer-to-peer "support" payments with a 70/30 split, withdrawal (request → settle/fail), and escrow (fund/release/refund) — all on Next.js (App Router) + TypeScript + Supabase/Postgres.

See [`SECURITY.md`](./SECURITY.md) and [`NOTES.md`](./NOTES.md) for the required write-ups.

## Setup (from a clean clone)

Prerequisites: Node 18+, Docker Desktop running.

```bash
npm install
npm install supabase --save-dev   # Supabase CLI as a project-local devDependency
npx supabase start                # starts local Postgres/Auth/Studio in Docker
```

`npx supabase start` prints local API keys. Create `.env.local` in the project root:

```
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<Publishable key from supabase start>
SUPABASE_SECRET_KEY=<Secret key from supabase start>
PAYMENT_WEBHOOK_SECRET=<any random hex string, e.g. `openssl rand -hex 32`>
PAYOUT_WEBHOOK_SECRET=<any random hex string, different from the above>
```

Apply the schema (also seeds 3 demo users — alice/bob/carol @valoron.test, password `demopassword123` — all starting at ₹0, funded only through the real deposit flow):

```bash
npx supabase db reset
```

Run the app:

```bash
npm run dev
```

Open `https://valoron-wallet.onrender.com`, log in as any demo user, and use Deposit / Send / Withdraw / Escrow. Deposits go through a real intent → signed-webhook round trip; the "pay now" step is simulated by `/api/dev/simulate-provider`, which server-side constructs and HMAC-signs the same webhook payload a real gateway would send, then posts it to the real `/api/webhooks/payment` verification path. The webhook secrets never reach the browser.

## Webhook / concurrency proof script

```bash
node scripts/prove-it.mjs
```

Requires `supabase start` and `npm run dev` both running. Fires the 8 required scenarios against the live stack (tests 1–5 hit `/api/webhooks/payment` over real HTTP; tests 6–8 call the Postgres RPCs directly with a real logged-in user's JWT, to exercise the actual RLS/ownership/grant enforcement without needing to simulate a browser cookie session from a script).

Actual output from a real run against this repo:

```
=== Valoron Wallet proof script ===

Created test users prove-it-1785781816479@valoron.test and prove-it-recipient-1785781816479@valoron.test

[PASS] 1. Valid deposit webhook
       expected: credited once
       detail:   status=200, balance 0 -> 100000
[PASS] 2. Same webhook, 20x in parallel
       expected: credited once total
       detail:   balance stayed at 100000, statuses=[200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200,200]
[PASS] 3. Tampered amount_paise, original signature
       expected: rejected
       detail:   status=401, body={"code":"INVALID_SIGNATURE"}
[PASS] 4. Valid signature, timestamp 2 hours old
       expected: rejected
       detail:   status=401, body={"code":"STALE_TIMESTAMP"}
[PASS] 5. No signature header
       expected: rejected
       detail:   status=401, body={"code":"INVALID_SIGNATURE"}
[PASS] 6. Withdraw full balance, then immediately send
       expected: payment fails -- funds are locked
       detail:   withdrawStatus=200, sendStatus=400, sendBody={"code":"P1001","details":null,"hint":null,"message":"insufficient funds"}
[PASS] 7. Same withdrawal request submitted twice
       expected: one payout, not two
       detail:   first request_id=3d3dadc4-3146-4bd5-a4ab-fafea47e2fee, replay request_id=3d3dadc4-3146-4bd5-a4ab-fafea47e2fee
[PASS] 8. User attempts to settle their own withdrawal
       expected: rejected
       detail:   status=403, body={"code":"42501","details":null,"hint":null,"message":"permission denied for function settle_withdrawal"}

=== 8 passed, 0 failed ===
```

## What's done vs. not, honestly

**Done and manually verified end-to-end in a real browser:** login/switch-user, deposit (full intent→webhook round trip), sub-rupee send with exact 70/30 split, withdraw (immediate lock of funds), escrow fund + release. All 8 required proof-script scenarios pass. Ledger sums to zero and `account_balances` matches `SUM(ledger_entries)` at every point checked (see `SECURITY.md` invariant discussion).

**Done but only verified via direct RPC calls, not clicked through the UI:** escrow refund; the payout webhook (`settle_withdrawal`/`fail_withdrawal`) — there's no "simulate payout provider" UI button, only the deposit side has one.

**Not built:** a formal automated test suite (Vitest/Jest) beyond `scripts/prove-it.mjs`; a UI-level regression test for the optimistic-update rollback path (verified manually for one failure case, not systematically).

**Known weak points**, detailed honestly in `SECURITY.md`: the rate limiter is a blunt per-user hourly counter with no IP-based layer; and there's a PostgREST/`SECURITY DEFINER` permission interaction I hit mid-build and worked around (explicit broad grants to `service_role`) without fully understanding the root cause — write-up and reasoning for why this doesn't create an actual hole (given `service_role` is already fully trusted and server-only) is in `SECURITY.md`.

If something in this repo doesn't work exactly as described above, that section of `SECURITY.md`/`NOTES.md` is the place it's disclosed — this submission was built and documented under real time pressure, and the goal was to be honest about scope rather than to hide gaps.
