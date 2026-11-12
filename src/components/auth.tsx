"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DEMO_PASSWORD, DEMO_USERS } from "@/lib/demo";
import { Logo } from "./site";
import styles from "./auth.module.css";

type Mode = "login" | "signup";

const POINTS = [
  { title: "Double-entry ledger", body: "Every rupee is backed by matching debit and credit rows." },
  { title: "Escrow built in", body: "Hold money for a job and release or refund it later." },
  { title: "Retry-safe", body: "A double click or a repeated webhook never moves money twice." },
];

export function AuthPage({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isLogin = mode === "login";

  function done() {
    router.replace("/wallet");
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isLogin && password.length < 6) {
      setError("Use a password of at least 6 characters.");
      return;
    }
    setBusy("form");
    const { error: err } = isLogin
      ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
      : await supabase.auth.signUp({ email: email.trim(), password });
    setBusy(null);
    if (err) {
      setError(isLogin ? "That email and password don't match an account." : err.message);
      return;
    }
    done();
  }

  async function demo(demoEmail: string) {
    setError(null);
    setBusy(demoEmail);
    const { error: err } = await supabase.auth.signInWithPassword({ email: demoEmail, password: DEMO_PASSWORD });
    setBusy(null);
    if (err) {
      setError(`Demo sign-in failed: ${err.message}`);
      return;
    }
    done();
  }

  return (
    <div className={styles.split}>
      <aside className={styles.panel}>
        <Logo inverted />
        <div className={styles.panelBody}>
          <h1 className={styles.panelTitle}>A wallet that can show where every rupee came from.</h1>
          <ul className={styles.points}>
            {POINTS.map((p) => (
              <li key={p.title}>
                <span className={styles.pointIcon} aria-hidden>
                  ✓
                </span>
                <div>
                  <strong>{p.title}</strong>
                  <span>{p.body}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className={styles.panelFoot}>Balances held in INR. Payments are simulated in this demo.</p>
      </aside>

      <main className={styles.formSide}>
        <Link href="/" className={styles.back}>
          ← Back to home
        </Link>
        <div className={styles.formBox}>
          <h2 className={styles.title}>{isLogin ? "Welcome back" : "Create your account"}</h2>
          <p className={styles.sub}>{isLogin ? "Log in to your Valoron wallet." : "It takes less than a minute."}</p>

          <form className={styles.form} onSubmit={submit}>
            <label className={styles.field}>
              <span>Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Password</span>
              <input
                type="password"
                required
                autoComplete={isLogin ? "current-password" : "new-password"}
                placeholder={isLogin ? "Your password" : "At least 6 characters"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <button className={styles.submit} disabled={busy !== null}>
              {busy === "form" ? (isLogin ? "Logging in…" : "Creating account…") : isLogin ? "Log in" : "Create account"}
            </button>
          </form>

          <div className={styles.divider}>
            <span>or try a demo account</span>
          </div>

          <div className={styles.demoList}>
            {DEMO_USERS.map((u) => (
              <button key={u.id} type="button" className={styles.demo} onClick={() => demo(u.email)} disabled={busy !== null}>
                <span className={styles.avatar}>{u.name.charAt(0)}</span>
                <span className={styles.demoText}>
                  <strong>{u.name}</strong>
                  <span>{u.email}</span>
                </span>
                <span aria-hidden>{busy === u.email ? "…" : "→"}</span>
              </button>
            ))}
          </div>

          <p className={styles.switch}>
            {isLogin ? (
              <>
                New to Valoron? <Link href="/signup">Create an account</Link>
              </>
            ) : (
              <>
                Already have an account? <Link href="/login">Log in</Link>
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  );
}
