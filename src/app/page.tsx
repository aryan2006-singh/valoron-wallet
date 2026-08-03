"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const DEMO_USERS = [
  { id: "a0000000-0000-0000-0000-000000000001", email: "alice@valoron.test" },
  { id: "a0000000-0000-0000-0000-000000000002", email: "bob@valoron.test" },
  { id: "a0000000-0000-0000-0000-000000000003", email: "carol@valoron.test" },
];
const DEMO_PASSWORD = "demopassword123";

type Balance = { account_id: string; account_type: string; balance_paise: number };
type LedgerRow = { id: string; amount_paise: number; entry_type: string; created_at: string };
type EscrowHold = {
  id: string;
  funder_id: string;
  worker_id: string;
  amount_paise: number;
  status: string;
};

function rupees(paise: number) {
  return (paise / 100).toFixed(2);
}

function toPaise(rupeeStr: string): number | null {
  const value = Number(rupeeStr);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export default function Home() {
  const [supabase] = useState(() => createClient());
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [holds, setHolds] = useState<EscrowHold[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [depositAmount, setDepositAmount] = useState("1.00");
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("0.05");
  const [withdrawAmount, setWithdrawAmount] = useState("100.00");
  const [withdrawDestination, setWithdrawDestination] = useState("test@upi");
  const [escrowWorker, setEscrowWorker] = useState("");
  const [escrowAmount, setEscrowAmount] = useState("1.00");

  const refresh = useCallback(async () => {
    const { data: balanceRows } = await supabase.from("my_balances").select("*");
    if (balanceRows) setBalances(balanceRows as Balance[]);

    const { data: ledgerRows } = await supabase
      .from("ledger_entries")
      .select("id, amount_paise, entry_type, created_at")
      .order("created_at", { ascending: false })
      .limit(25);
    if (ledgerRows) setLedger(ledgerRows as LedgerRow[]);

    const { data: holdRows } = await supabase
      .from("escrow_holds")
      .select("id, funder_id, worker_id, amount_paise, status")
      .order("created_at", { ascending: false });
    if (holdRows) setHolds(holdRows as EscrowHold[]);
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
      setEmail(data.user?.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
      setEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (userId) refresh();
  }, [userId, refresh]);

  async function signInAs(demoEmail: string) {
    setMessage(null);
    const { error } = await supabase.auth.signInWithPassword({ email: demoEmail, password: DEMO_PASSWORD });
    if (error) setMessage(`Login failed: ${error.message}`);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setBalances([]);
    setLedger([]);
    setHolds([]);
  }

  function balanceFor(type: string) {
    return balances.find((b) => b.account_type === type)?.balance_paise ?? 0;
  }

  async function callApi(path: string, body: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.code ?? "ERROR");
    return json;
  }

  async function handleDeposit() {
    const amount = toPaise(depositAmount);
    if (amount === null) return setMessage("Enter a valid deposit amount.");
    setBusy("deposit");
    setMessage(null);
    try {
      const { intentId } = await callApi("/api/deposit/intent", { amountPaise: amount });
      await callApi("/api/dev/simulate-provider", { intentId });
      await refresh();
      setMessage(`Deposited Rs.${depositAmount} (webhook confirmed).`);
    } catch (err) {
      setMessage(`Deposit failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleSend() {
    const amount = toPaise(sendAmount);
    if (!sendRecipient) return setMessage("Pick a recipient.");
    if (amount === null) return setMessage("Enter a valid amount.");
    if (amount > balanceFor("available")) return setMessage("Insufficient available balance.");

    setBusy("send");
    setMessage(null);
    setBalances((prev) =>
      prev.map((b) => (b.account_type === "available" ? { ...b, balance_paise: b.balance_paise - amount } : b))
    );
    try {
      await callApi("/api/support", {
        recipientId: sendRecipient,
        amountPaise: amount,
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
      setMessage(`Sent Rs.${sendAmount}.`);
    } catch (err) {
      await refresh();
      setMessage(`Send failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleWithdraw() {
    const amount = toPaise(withdrawAmount);
    if (amount === null) return setMessage("Enter a valid amount.");
    if (amount > balanceFor("available")) return setMessage("Insufficient available balance.");

    setBusy("withdraw");
    setMessage(null);
    setBalances((prev) =>
      prev.map((b) => {
        if (b.account_type === "available") return { ...b, balance_paise: b.balance_paise - amount };
        if (b.account_type === "payout") return { ...b, balance_paise: b.balance_paise + amount };
        return b;
      })
    );
    try {
      await callApi("/api/withdraw", {
        amountPaise: amount,
        destination: withdrawDestination,
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
      setMessage(`Withdrawal of Rs.${withdrawAmount} requested.`);
    } catch (err) {
      await refresh();
      setMessage(`Withdrawal failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleFundEscrow() {
    const amount = toPaise(escrowAmount);
    if (!escrowWorker) return setMessage("Pick a worker.");
    if (amount === null) return setMessage("Enter a valid amount.");
    if (amount > balanceFor("available")) return setMessage("Insufficient available balance.");

    setBusy("escrow-fund");
    setMessage(null);
    setBalances((prev) =>
      prev.map((b) => {
        if (b.account_type === "available") return { ...b, balance_paise: b.balance_paise - amount };
        if (b.account_type === "escrow") return { ...b, balance_paise: b.balance_paise + amount };
        return b;
      })
    );
    try {
      await callApi("/api/escrow/fund", {
        workerId: escrowWorker,
        amountPaise: amount,
        idempotencyKey: crypto.randomUUID(),
      });
      await refresh();
      setMessage(`Escrow funded with Rs.${escrowAmount}.`);
    } catch (err) {
      await refresh();
      setMessage(`Escrow fund failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleReleaseEscrow(holdId: string) {
    setBusy(`release-${holdId}`);
    setMessage(null);
    try {
      await callApi("/api/escrow/release", { holdId, idempotencyKey: crypto.randomUUID() });
      await refresh();
      setMessage("Escrow released.");
    } catch (err) {
      setMessage(`Release failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRefundEscrow(holdId: string) {
    setBusy(`refund-${holdId}`);
    setMessage(null);
    try {
      await callApi("/api/escrow/refund", { holdId, idempotencyKey: crypto.randomUUID() });
      await refresh();
      setMessage("Escrow refunded.");
    } catch (err) {
      setMessage(`Refund failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (!userId) {
    return (
      <main style={{ padding: 24, fontFamily: "monospace" }}>
        <h1>Valoron Wallet (demo)</h1>
        <p>Log in as one of the demo users:</p>
        {DEMO_USERS.map((u) => (
          <button key={u.id} onClick={() => signInAs(u.email)} style={{ marginRight: 8 }}>
            Log in as {u.email}
          </button>
        ))}
        {message && <p style={{ color: "crimson" }}>{message}</p>}
      </main>
    );
  }

  const otherUsers = DEMO_USERS.filter((u) => u.id !== userId);
  const sendAmountPaise = toPaise(sendAmount);

  return (
    <main style={{ padding: 24, fontFamily: "monospace", maxWidth: 720 }}>
      <h1>Valoron Wallet (demo)</h1>
      <p>
        Signed in as <b>{email}</b>{" "}
        <button onClick={signOut}>Switch user</button>
      </p>

      <section style={{ border: "1px solid #888", padding: 12, marginBottom: 16 }}>
        <h2>Balances</h2>
        <p>Available (spendable): Rs.{rupees(balanceFor("available"))}</p>
        <p>Escrow (locked in jobs): Rs.{rupees(balanceFor("escrow"))}</p>
        <p>Pending withdrawal (not spendable): Rs.{rupees(balanceFor("payout"))}</p>
      </section>

      <section style={{ border: "1px solid #888", padding: 12, marginBottom: 16 }}>
        <h2>Deposit</h2>
        <input value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
        <button onClick={handleDeposit} disabled={busy === "deposit"}>
          {busy === "deposit" ? "Depositing..." : "Deposit"}
        </button>
      </section>

      <section style={{ border: "1px solid #888", padding: 12, marginBottom: 16 }}>
        <h2>Send support</h2>
        <select value={sendRecipient} onChange={(e) => setSendRecipient(e.target.value)}>
          <option value="">Pick recipient</option>
          {otherUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>{" "}
        <input value={sendAmount} onChange={(e) => setSendAmount(e.target.value)} />{" "}
        <button
          onClick={handleSend}
          disabled={busy === "send" || !sendRecipient || sendAmountPaise === null || sendAmountPaise > balanceFor("available")}
        >
          {busy === "send" ? "Sending..." : "Send"}
        </button>
        {sendAmountPaise !== null && (
          <p>
            Split preview: recipient gets Rs.{rupees(sendAmountPaise - Math.floor((sendAmountPaise * 30) / 100))}, platform
            fee Rs.{rupees(Math.floor((sendAmountPaise * 30) / 100))}
          </p>
        )}
      </section>

      <section style={{ border: "1px solid #888", padding: 12, marginBottom: 16 }}>
        <h2>Withdraw</h2>
        <input value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} />{" "}
        <input
          value={withdrawDestination}
          onChange={(e) => setWithdrawDestination(e.target.value)}
          placeholder="UPI id"
        />{" "}
        <button
          onClick={handleWithdraw}
          disabled={busy === "withdraw" || (toPaise(withdrawAmount) ?? 0) > balanceFor("available")}
        >
          {busy === "withdraw" ? "Requesting..." : "Withdraw"}
        </button>
      </section>

      <section style={{ border: "1px solid #888", padding: 12, marginBottom: 16 }}>
        <h2>Escrow</h2>
        <select value={escrowWorker} onChange={(e) => setEscrowWorker(e.target.value)}>
          <option value="">Pick worker</option>
          {otherUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </select>{" "}
        <input value={escrowAmount} onChange={(e) => setEscrowAmount(e.target.value)} />{" "}
        <button
          onClick={handleFundEscrow}
          disabled={busy === "escrow-fund" || !escrowWorker || (toPaise(escrowAmount) ?? 0) > balanceFor("available")}
        >
          {busy === "escrow-fund" ? "Funding..." : "Fund escrow"}
        </button>

        <ul>
          {holds.map((h) => (
            <li key={h.id}>
              Rs.{rupees(h.amount_paise)} - status: {h.status} - funder {h.funder_id === userId ? "me" : h.funder_id} -
              worker {h.worker_id === userId ? "me" : h.worker_id}{" "}
              {h.status === "held" && h.funder_id === userId && (
                <>
                  <button onClick={() => handleReleaseEscrow(h.id)} disabled={busy === `release-${h.id}`}>
                    Release
                  </button>{" "}
                  <button onClick={() => handleRefundEscrow(h.id)} disabled={busy === `refund-${h.id}`}>
                    Refund
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section style={{ border: "1px solid #888", padding: 12 }}>
        <h2>Transactions</h2>
        <ul>
          {ledger.map((row) => (
            <li key={row.id}>
              {new Date(row.created_at).toLocaleString()} - {row.entry_type} -{" "}
              {row.amount_paise > 0 ? "+" : ""}
              Rs.{rupees(row.amount_paise)}
            </li>
          ))}
        </ul>
      </section>

      {message && <p>{message}</p>}
    </main>
  );
}
