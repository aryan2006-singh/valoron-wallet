import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site";
import { createClient } from "@/lib/supabase/server";
import styles from "./landing.module.css";

const FEATURES = [
  {
    icon: "in",
    title: "Add money",
    body: "Top up your wallet in rupees. Funds are credited only when the payment provider's signed webhook confirms the payment, never because the browser said so.",
  },
  {
    icon: "send",
    title: "Send support",
    body: "Pay another Valoron user in one step. The 70/30 split between recipient and platform is written as matching ledger entries in a single database transaction.",
  },
  {
    icon: "lock",
    title: "Escrow for jobs",
    body: "Lock money for a piece of work. Release it to the worker when it is done, or refund it to yourself. Held funds sit in their own account until then.",
  },
  {
    icon: "out",
    title: "Withdraw to UPI",
    body: "Request a payout to your UPI ID. The amount moves to a pending account and only leaves once the payout settles. If it fails, it returns to your wallet.",
  },
  {
    icon: "list",
    title: "Readable history",
    body: "Every movement shows up as a clear line in your activity: what happened, when, and which account it touched. Nothing is hidden behind a single number.",
  },
  {
    icon: "shield",
    title: "Retry-safe actions",
    body: "Each payment carries a unique key. Pressing a button twice, or a webhook arriving twice, can never charge or credit you twice.",
  },
];

const GUARANTEES = [
  {
    title: "Double-entry, append-only ledger",
    body: "Every movement writes matching debit and credit rows that must sum to zero. Database triggers block edits and deletes, so history cannot be rewritten.",
  },
  {
    title: "Row-level security on every table",
    body: "Postgres policies mean each user can only read their own accounts and entries, even if application code has a bug.",
  },
  {
    title: "Balances that cannot go negative",
    body: "The database itself rejects any change that would push a wallet below zero, so overspending is impossible rather than merely discouraged.",
  },
  {
    title: "Signed webhooks and an audit trail",
    body: "Payment and payout callbacks are verified with an HMAC signature, and sensitive actions are recorded in an audit log that cannot be edited.",
  },
];

const STEPS = [
  { title: "Create your account", body: "Sign up with your email and password, or try one of the demo accounts in a single click." },
  { title: "Add money", body: "Top up your wallet. The payment is confirmed by a verified webhook and credited to your ledger." },
  { title: "Send, hold or withdraw", body: "Support another user, lock money in escrow for a job, or withdraw to your UPI ID." },
];

const STATS = [
  { value: "4", label: "Money flows: add, send, escrow, withdraw" },
  { value: "70/30", label: "Support split, written as ledger entries" },
  { value: "0", label: "Ways to edit or delete a ledger entry" },
];

export default async function Landing() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const signedIn = Boolean(user);

  return (
    <>
      <SiteHeader signedIn={signedIn} />
      <main className={styles.main}>
        {/* Hero */}
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <span className={styles.badge}>
                <Icon name="shield" size={14} /> Double-entry ledger · Escrow · UPI payouts
              </span>
              <h1 className={styles.heroTitle}>
                Every rupee,
                <br />
                accounted for twice.
              </h1>
              <p className={styles.heroSub}>
                Valoron is a rupee wallet built on a double-entry ledger. Add money, send support, hold funds in escrow
                and withdraw to UPI, and every balance can be traced back through its own history.
              </p>
              <div className={styles.heroActions}>
                {signedIn ? (
                  <Link href="/wallet" className={styles.btnPrimary}>
                    Open your wallet <span aria-hidden>→</span>
                  </Link>
                ) : (
                  <>
                    <Link href="/signup" className={styles.btnPrimary}>
                      Create your account <span aria-hidden>→</span>
                    </Link>
                    <Link href="/login" className={styles.btnSecondary}>
                      Try the demo
                    </Link>
                  </>
                )}
              </div>
              <ul className={styles.checks}>
                <li>Append-only history</li>
                <li>Retry-safe payments</li>
                <li>No negative balances</li>
              </ul>
            </div>

            <div className={styles.heroVisual} aria-hidden>
              <div className={styles.ring} />
              <div className={styles.walletCard}>
                <div className={styles.cardTop}>
                  <span className={styles.cardBrand}>VALORON</span>
                  <span className={styles.cardSub}>RUPEE WALLET</span>
                </div>
                <div>
                  <p className={styles.cardLabel}>Available balance</p>
                  <p className={styles.cardAmount}>₹12,480.00</p>
                </div>
                <p className={styles.cardCheck}>
                  <span>✓</span> Matches 1,204 ledger entries
                </p>
                <div className={styles.cardFoot}>
                  <div>
                    <p className={styles.cardLabel}>Account holder</p>
                    <p className={styles.cardValue}>A. SHARMA</p>
                  </div>
                  <div>
                    <p className={styles.cardLabel}>In escrow</p>
                    <p className={styles.cardValue}>₹2,000.00</p>
                  </div>
                </div>
              </div>
              <div className={styles.miniCard}>
                <span className={styles.miniIcon}>↓</span>
                <div>
                  <p className={styles.miniTitle}>Money added</p>
                  <p className={styles.miniMeta}>Verified by webhook</p>
                </div>
                <span className={styles.miniAmount}>+₹500.00</span>
              </div>
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className={styles.stats} aria-label="At a glance">
          {STATS.map((s) => (
            <div key={s.label} className={styles.stat}>
              <p className={styles.statValue}>{s.value}</p>
              <p className={styles.statLabel}>{s.label}</p>
            </div>
          ))}
        </section>

        {/* Features */}
        <section id="features" className={styles.section}>
          <p className={styles.eyebrow}>Features</p>
          <h2 className={styles.sectionTitle}>Everything a wallet needs, done carefully</h2>
          <p className={styles.sectionSub}>Each flow is designed so the failure case is as well defined as the happy path.</p>
          <div className={styles.cardGrid}>
            {FEATURES.map((f) => (
              <article key={f.title} className={styles.featureCard}>
                <span className={styles.iconBox}>
                  <Icon name={f.icon} />
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Security */}
        <section id="security" className={styles.dark}>
          <div className={styles.darkInner}>
            <div className={styles.darkIntro}>
              <p className={styles.eyebrowDark}>Security</p>
              <h2 className={styles.sectionTitleDark}>Correctness is the feature</h2>
              <p className={styles.darkSub}>
                Money bugs are expensive and quiet. These guarantees are enforced by the database itself, not left to
                application code.
              </p>
            </div>
            <div className={styles.guaranteeGrid}>
              {GUARANTEES.map((g) => (
                <article key={g.title} className={styles.guarantee}>
                  <span className={styles.iconBoxDark}>
                    <Icon name="check" />
                  </span>
                  <h3>{g.title}</h3>
                  <p>{g.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how-it-works" className={styles.section}>
          <p className={styles.eyebrow}>How it works</p>
          <h2 className={styles.sectionTitle}>Up and running in three steps</h2>
          <div className={styles.stepGrid}>
            {STEPS.map((s, i) => (
              <article key={s.title} className={styles.stepCard}>
                <span className={styles.stepNum}>{String(i + 1).padStart(2, "0")}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className={styles.ctaWrap}>
          <div className={styles.cta}>
            <h2>Open your wallet in under a minute</h2>
            <p>Create an account or pick a demo user, then make your first deposit.</p>
            <Link href={signedIn ? "/wallet" : "/signup"} className={styles.btnPrimary}>
              {signedIn ? "Go to your wallet" : "Get started free"} <span aria-hidden>→</span>
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    in: <path d="M17 7 7 17M7 8v9h9" />,
    out: <path d="M7 17 17 7M8 7h9v9" />,
    send: <path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" />,
    lock: (
      <>
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
    check: <path d="M20 6 9 17l-5-5" />,
  };
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name]}
    </svg>
  );
}
