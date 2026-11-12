"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { entryLabel, formatDate, formatRupees, friendlyError, toPaise } from "@/lib/format";
import styles from "./page.module.css";

const DEMO_USERS = [
  { id: "a0000000-0000-0000-0000-000000000001", email: "alice@valoron.test", name: "Alice" },
  { id: "a0000000-0000-0000-0000-000000000002", email: "bob@valoron.test", name: "Bob" },
  { id: "a0000000-0000-0000-0000-000000000003", email: "carol@valoron.test", name: "Carol" },
];
const DEMO_PASSWORD = "demopassword123";
const PLATFORM_FEE_PERCENT = 30;
const MIN_WITHDRAW_PAISE = 10000; // mirrors request_withdrawal() in the database

type Balance = { account_id: string; account_type: string; balance_paise: number };
type LedgerRow = {
  id: string;
  account_id: string;
  transaction_id: string;
  amount_paise: number;
  entry_type: string;
  created_at: string;
};

const ACCOUNT_LABELS: Record<string, string> = {
  available: "Wallet",
  escrow: "Escrow",
  payout: "Pending withdrawal",
};

// Each transaction writes several ledger legs (e.g. wallet -75, escrow +75).
// Show one row per transaction: the wallet leg when there is one, else the first leg.
function collapseLedger(rows: LedgerRow[], accountType: (accountId: string) => string | undefined) {
  const byTx = new Map<string, LedgerRow>();
  for (const row of rows) {
    const current = byTx.get(row.transaction_id);
    if (!current || (accountType(row.account_id) === "available" && accountType(current.account_id) !== "available")) {
      byTx.set(row.transaction_id, row);
    }
  }
  return [...byTx.values()];
}
type EscrowHold = {
  id: string;
  funder_id: string;
  worker_id: string;
  amount_paise: number;
  status: string;
};
type Notice = { tone: "success" | "error"; text: string };
type Tab = "deposit" | "send" | "withdraw" | "escrow";

const TABS: { id: Tab; label: string }[] = [
  { id: "deposit", label: "Add money" },
  { id: "send", label: "Send" },
  { id: "withdraw", label: "Withdraw" },
  { id: "escrow", label: "Escrow" },
];

function userFor(id: string) {
  return DEMO_USERS.find((u) => u.id === id);
}

function displayName(id: string, me: string | null) {
  if (id === me) return "You";
  return userFor(id)?.email ?? `${id.slice(0, 8)}…`;
}

function initials(email: string) {
  return email.charAt(0).toUpperCase();
}

function feeFor(paise: number) {
  return Math.floor((paise * PLATFORM_FEE_PERCENT) / 100);
}

export default function Home() {
  const [supabase] = useState(() => createClient());
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [holds, setHolds] = useState<EscrowHold[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tab, setTab] = useState<Tab>("deposit");

  const [depositAmount, setDepositAmount] = useState("100");
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("10");
  const [withdrawAmount, setWithdrawAmount] = useState("100");
  const [withdrawDestination, setWithdrawDestination] = useState("test@upi");
  const [escrowWorker, setEscrowWorker] = useState("");
  const [escrowAmount, setEscrowAmount] = useState("50");

  const refresh = useCallback(async () => {
    const [{ data: balanceRows }, { data: ledgerRows }, { data: holdRows }] = await Promise.all([
      supabase.from("my_balances").select("*"),
      supabase
        .from("ledger_entries")
        .select("id, account_id, transaction_id, amount_paise, entry_type, created_at")
        .order("created_at", { ascending: false })
        .limit(60),
      supabase
        .from("escrow_holds")
        .select("id, funder_id, worker_id, amount_paise, status")
        .order("created_at", { ascending: false }),
    ]);
    if (balanceRows) setBalances(balanceRows as Balance[]);
    if (ledgerRows) setLedger(ledgerRows as LedgerRow[]);
    if (holdRows) setHolds(holdRows as EscrowHold[]);
  }, [supabase]);

  useEffect(() => {
    // Load wallet data from the auth callbacks rather than from a separate
    // effect keyed on userId, so we never set state synchronously in an effect.
    function applyUser(user: User | null) {
      setUserId(user?.id ?? null);
      setEmail(user?.email ?? null);
      setAuthReady(true);
      if (user) void refresh();
    }
    supabase.auth.getUser().then(({ data }) => applyUser(data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") applyUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase, refresh]);

  async function signInAs(demoEmail: string) {
    setNotice(null);
    setBusy(`login-${demoEmail}`);
    const { error } = await supabase.auth.signInWithPassword({ email: demoEmail, password: DEMO_PASSWORD });
    setBusy(null);
    if (error) setNotice({ tone: "error", text: `Sign-in failed: ${error.message}` });
  }

  async function signOut() {
    await supabase.auth.signOut();
    setBalances([]);
    setLedger([]);
    setHolds([]);
    setNotice(null);
  }

  function balanceFor(type: string) {
    return balances.find((b) => b.account_type === type)?.balance_paise ?? 0;
  }

  const available = balanceFor("available");

  async function callApi(path: string, body: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.code ?? "INTERNAL_ERROR");
    return json;
  }

  function adjustBalances(deltas: Record<string, number>) {
    setBalances((prev) =>
      prev.map((b) => (b.account_type in deltas ? { ...b, balance_paise: b.balance_paise + deltas[b.account_type] } : b))
    );
  }

  async function run(key: string, action: () => Promise<string>, failPrefix: string) {
    setBusy(key);
    setNotice(null);
    try {
      const text = await action();
      setNotice({ tone: "success", text });
    } catch (err) {
      await refresh();
      setNotice({ tone: "error", text: `${failPrefix}: ${friendlyError((err as Error).message)}` });
    } finally {
      setBusy(null);
    }
  }

  function fail(text: string) {
    setNotice({ tone: "error", text });
  }

  async function handleDeposit() {
    const amount = toPaise(depositAmount);
    if (amount === null) return fail("Enter an amount greater than zero.");
    await run(
      "deposit",
      async () => {
        const { intentId } = await callApi("/api/deposit/intent", { amountPaise: amount });
        await callApi("/api/dev/simulate-provider", { intentId });
        await refresh();
        return `Added ${formatRupees(amount)} to your wallet.`;
      },
      "Couldn't add money"
    );
  }

  async function handleSend() {
    const amount = toPaise(sendAmount);
    if (!sendRecipient) return fail("Choose who to send to.");
    if (amount === null) return fail("Enter an amount greater than zero.");
    if (amount > available) return fail("You don't have enough available balance for that.");
    adjustBalances({ available: -amount });
    await run(
      "send",
      async () => {
        await callApi("/api/support", {
          recipientId: sendRecipient,
          amountPaise: amount,
          idempotencyKey: crypto.randomUUID(),
        });
        await refresh();
        return `Sent ${formatRupees(amount)} to ${userFor(sendRecipient)?.email}.`;
      },
      "Couldn't send"
    );
  }

  async function handleWithdraw() {
    const amount = toPaise(withdrawAmount);
    if (amount === null) return fail("Enter an amount greater than zero.");
    if (amount < MIN_WITHDRAW_PAISE) return fail(`The minimum withdrawal is ${formatRupees(MIN_WITHDRAW_PAISE)}.`);
    if (!withdrawDestination.trim()) return fail("Enter a UPI ID to withdraw to.");
    if (amount > available) return fail("You don't have enough available balance for that.");
    adjustBalances({ available: -amount, payout: amount });
    await run(
      "withdraw",
      async () => {
        await callApi("/api/withdraw", {
          amountPaise: amount,
          destination: withdrawDestination.trim(),
          idempotencyKey: crypto.randomUUID(),
        });
        await refresh();
        return `Withdrawal of ${formatRupees(amount)} requested.`;
      },
      "Couldn't withdraw"
    );
  }

  async function handleFundEscrow() {
    const amount = toPaise(escrowAmount);
    if (!escrowWorker) return fail("Choose a worker for this escrow.");
    if (amount === null) return fail("Enter an amount greater than zero.");
    if (amount > available) return fail("You don't have enough available balance for that.");
    adjustBalances({ available: -amount, escrow: amount });
    await run(
      "escrow-fund",
      async () => {
        await callApi("/api/escrow/fund", {
          workerId: escrowWorker,
          amountPaise: amount,
          idempotencyKey: crypto.randomUUID(),
        });
        await refresh();
        return `${formatRupees(amount)} locked in escrow for ${userFor(escrowWorker)?.email}.`;
      },
      "Couldn't fund escrow"
    );
  }

  async function handleSettleEscrow(holdId: string, kind: "release" | "refund") {
    await run(
      `${kind}-${holdId}`,
      async () => {
        await callApi(`/api/escrow/${kind}`, { holdId, idempotencyKey: crypto.randomUUID() });
        await refresh();
        return kind === "release" ? "Escrow released to the worker." : "Escrow refunded to your wallet.";
      },
      kind === "release" ? "Couldn't release" : "Couldn't refund"
    );
  }

  if (!authReady) {
    return (
      <main className={styles.center}>
        <div className={styles.spinner} aria-label="Loading" />
      </main>
    );
  }

  if (!userId) {
    return (
      <main className={styles.center}>
        <div className={styles.loginCard}>
          <Logo />
          <Tiles small />
          <h1 className={styles.loginTitle}>Money, moved simply.</h1>
          <p className={styles.loginSub}>A demo wallet for deposits, support payments, escrow and withdrawals.</p>
          <p className={styles.sectionLabel}>Choose a demo account</p>
          <div className={styles.userList}>
            {DEMO_USERS.map((u) => (
              <button
                key={u.id}
                className={styles.userTile}
                onClick={() => signInAs(u.email)}
                disabled={busy !== null}
              >
                <span className={styles.avatar} data-user={u.name.toLowerCase()}>
                  {initials(u.email)}
                </span>
                <span className={styles.userTileText}>
                  <strong>{u.name}</strong>
                  <span>{u.email}</span>
                </span>
                <span className={styles.chevron} aria-hidden>
                  {busy === `login-${u.email}` ? "…" : "→"}
                </span>
              </button>
            ))}
          </div>
          {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}
        </div>
      </main>
    );
  }

  const otherUsers = DEMO_USERS.filter((u) => u.id !== userId);
  const sendPaise = toPaise(sendAmount);
  const accountType = (accountId: string) => balances.find((b) => b.account_id === accountId)?.account_type;
  const activity = collapseLedger(ledger, accountType).slice(0, 20);
  const activeHolds = holds.filter((h) => h.status === "held");

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Logo />
        <span className={styles.tagline}>A wallet for small payments</span>
        <div className={styles.userChip}>
          <span className={styles.avatar} data-user={userFor(userId)?.name.toLowerCase()}>
            {initials(email ?? "?")}
          </span>
          <span className={styles.userEmail}>{email}</span>
          <button className={styles.ghostButton} onClick={signOut}>
            Switch user
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero} aria-label="Balances">
          <Tiles />
          <p className={styles.heroLabel}>Available balance</p>
          <p className={styles.heroAmount}>{formatRupees(available)}</p>
          <div className={styles.heroStats}>
            <div>
              <p className={styles.heroStatLabel}>In escrow</p>
              <p className={styles.heroStatValue}>{formatRupees(balanceFor("escrow"))}</p>
            </div>
            <div>
              <p className={styles.heroStatLabel}>Pending withdrawal</p>
              <p className={styles.heroStatValue}>{formatRupees(balanceFor("payout"))}</p>
            </div>
          </div>
        </section>

        {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}

        <div className={styles.grid}>
          <section className={styles.card} aria-label="Actions">
            <div className={styles.tabs} role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  className={styles.tab}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "deposit" && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  handleDeposit();
                }}
              >
                <p className={styles.formHint}>Top up your wallet. In this demo the payment is confirmed instantly.</p>
                <AmountField id="deposit-amount" value={depositAmount} onChange={setDepositAmount} />
                <QuickAmounts values={[100, 500, 1000]} onPick={setDepositAmount} />
                <button className={styles.primaryButton} disabled={busy === "deposit"}>
                  {busy === "deposit" ? "Adding money…" : "Add money"}
                </button>
              </form>
            )}

            {tab === "send" && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSend();
                }}
              >
                <p className={styles.formHint}>Send support to another user. A {PLATFORM_FEE_PERCENT}% platform fee applies.</p>
                <UserSelect id="send-recipient" label="Recipient" value={sendRecipient} onChange={setSendRecipient} users={otherUsers} />
                <AmountField id="send-amount" value={sendAmount} onChange={setSendAmount} max={available} />
                {sendPaise !== null && (
                  <dl className={styles.breakdown}>
                    <div>
                      <dt>Recipient gets</dt>
                      <dd>{formatRupees(sendPaise - feeFor(sendPaise))}</dd>
                    </div>
                    <div>
                      <dt>Platform fee</dt>
                      <dd>{formatRupees(feeFor(sendPaise))}</dd>
                    </div>
                    <div className={styles.breakdownTotal}>
                      <dt>You pay</dt>
                      <dd>{formatRupees(sendPaise)}</dd>
                    </div>
                  </dl>
                )}
                <button
                  className={styles.primaryButton}
                  disabled={busy === "send" || !sendRecipient || sendPaise === null || sendPaise > available}
                >
                  {busy === "send" ? "Sending…" : "Send support"}
                </button>
              </form>
            )}

            {tab === "withdraw" && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  handleWithdraw();
                }}
              >
                <p className={styles.formHint}>Move money out to your UPI ID. It stays pending until the payout settles. Minimum {formatRupees(MIN_WITHDRAW_PAISE)}.</p>
                <AmountField id="withdraw-amount" value={withdrawAmount} onChange={setWithdrawAmount} max={available} />
                <label className={styles.field} htmlFor="withdraw-destination">
                  <span className={styles.fieldLabel}>UPI ID</span>
                  <input
                    id="withdraw-destination"
                    className={styles.input}
                    value={withdrawDestination}
                    onChange={(e) => setWithdrawDestination(e.target.value)}
                    placeholder="name@bank"
                    autoComplete="off"
                  />
                </label>
                <button
                  className={styles.primaryButton}
                  disabled={busy === "withdraw" || (toPaise(withdrawAmount) ?? 0) > available}
                >
                  {busy === "withdraw" ? "Requesting…" : "Withdraw"}
                </button>
              </form>
            )}

            {tab === "escrow" && (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  handleFundEscrow();
                }}
              >
                <p className={styles.formHint}>Lock money for a job. Release it to the worker when done, or refund it.</p>
                <UserSelect id="escrow-worker" label="Worker" value={escrowWorker} onChange={setEscrowWorker} users={otherUsers} />
                <AmountField id="escrow-amount" value={escrowAmount} onChange={setEscrowAmount} max={available} />
                <button
                  className={styles.primaryButton}
                  disabled={busy === "escrow-fund" || !escrowWorker || (toPaise(escrowAmount) ?? 0) > available}
                >
                  {busy === "escrow-fund" ? "Locking…" : "Fund escrow"}
                </button>
              </form>
            )}
          </section>

          <section className={styles.card} aria-labelledby="escrow-heading">
            <div className={styles.cardHeader}>
              <h2 id="escrow-heading">
                <span className={styles.diamond} aria-hidden>◇</span>Escrow
              </h2>
              {activeHolds.length > 0 && <span className={styles.count}>{activeHolds.length} active</span>}
            </div>
            {holds.length === 0 ? (
              <p className={styles.empty}>No escrow yet. Fund one from the Escrow tab.</p>
            ) : (
              <ul className={styles.list}>
                {holds.map((h) => (
                  <li key={h.id} className={styles.holdRow}>
                    <div className={styles.rowMain}>
                      <span className={styles.rowTitle}>{formatRupees(h.amount_paise)}</span>
                      <span className={styles.rowMeta}>
                        {displayName(h.funder_id, userId)} → {displayName(h.worker_id, userId)}
                      </span>
                    </div>
                    <span className={styles.badge} data-status={h.status}>
                      {h.status}
                    </span>
                    {h.status === "held" && h.funder_id === userId && (
                      <div className={styles.rowActions}>
                        <button
                          className={styles.smallPrimary}
                          onClick={() => handleSettleEscrow(h.id, "release")}
                          disabled={busy !== null}
                        >
                          {busy === `release-${h.id}` ? "Releasing…" : "Release"}
                        </button>
                        <button
                          className={styles.smallSecondary}
                          onClick={() => handleSettleEscrow(h.id, "refund")}
                          disabled={busy !== null}
                        >
                          {busy === `refund-${h.id}` ? "Refunding…" : "Refund"}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`${styles.card} ${styles.wide}`} aria-labelledby="tx-heading">
            <div className={styles.cardHeader}>
              <h2 id="tx-heading">
                <span className={styles.diamond} aria-hidden>◇</span>Recent activity
              </h2>
            </div>
            {activity.length === 0 ? (
              <p className={styles.empty}>No transactions yet. Add money to get started.</p>
            ) : (
              <ul className={styles.list}>
                {activity.map((row) => (
                  <li key={row.id} className={styles.txRow}>
                    <span className={styles.txIcon} data-dir={row.amount_paise >= 0 ? "in" : "out"} aria-hidden>
                      {row.amount_paise >= 0 ? "↓" : "↑"}
                    </span>
                    <div className={styles.rowMain}>
                      <span className={styles.rowTitle}>{entryLabel(row.entry_type)}</span>
                      <span className={styles.rowMeta}>
                        {formatDate(row.created_at)}
                        {accountType(row.account_id) !== "available" &&
                          ` · ${ACCOUNT_LABELS[accountType(row.account_id) ?? ""] ?? "Other account"}`}
                      </span>
                    </div>
                    <span className={styles.txAmount} data-dir={row.amount_paise >= 0 ? "in" : "out"}>
                      {formatRupees(row.amount_paise, { signed: true })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function Logo() {
  return (
    <span className={styles.logo}>valoron</span>
  );
}

// Fanned stack of glossy tiles, pure CSS; decorative only.
function Tiles({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? styles.tilesSmall : styles.tiles} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={styles.tile} style={{ "--i": i } as CSSProperties} />
      ))}
    </div>
  );
}

function NoticeBar({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  return (
    <div className={styles.notice} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
      <span>{notice.text}</span>
      <button className={styles.noticeClose} onClick={onClose} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

function AmountField({
  id,
  value,
  onChange,
  max,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  max?: number;
}) {
  const paise = toPaise(value);
  const over = max !== undefined && paise !== null && paise > max;
  return (
    <label className={styles.field} htmlFor={id}>
      <span className={styles.fieldLabel}>
        Amount
        {max !== undefined && <span className={styles.fieldAside}>Available {formatRupees(max)}</span>}
      </span>
      <span className={styles.amountInput} data-invalid={over || undefined}>
        <span className={styles.currency}>₹</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
          autoComplete="off"
          aria-invalid={over}
        />
      </span>
      {over && <span className={styles.fieldError}>More than your available balance.</span>}
    </label>
  );
}

function QuickAmounts({ values, onPick }: { values: number[]; onPick: (v: string) => void }) {
  return (
    <div className={styles.chips}>
      {values.map((v) => (
        <button key={v} type="button" className={styles.chip} onClick={() => onPick(String(v))}>
          {formatRupees(v * 100).replace(".00", "")}
        </button>
      ))}
    </div>
  );
}

function UserSelect({
  id,
  label,
  value,
  onChange,
  users,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  users: typeof DEMO_USERS;
}) {
  return (
    <label className={styles.field} htmlFor={id}>
      <span className={styles.fieldLabel}>{label}</span>
      <select id={id} className={styles.input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a person</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} ({u.email})
          </option>
        ))}
      </select>
    </label>
  );
}
