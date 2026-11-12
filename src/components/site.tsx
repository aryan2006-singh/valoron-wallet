import Link from "next/link";
import styles from "./site.module.css";

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <span className={styles.logoMark} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2" />
        <path d="M3 6v12a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-3" />
      </svg>
    </span>
  );
}

export function Logo({ href = "/", inverted = false }: { href?: string; inverted?: boolean }) {
  return (
    <Link href={href} className={styles.logo} data-inverted={inverted || undefined}>
      <LogoMark />
      <span>Valoron</span>
    </Link>
  );
}

const NAV = [
  { href: "/#features", label: "Features" },
  { href: "/#security", label: "Security" },
  { href: "/#how-it-works", label: "How it works" },
];

export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <div className={styles.headerLeft}>
          <Logo />
          <nav className={styles.nav} aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className={styles.headerRight}>
          {signedIn ? (
            <Link href="/wallet" className={styles.btnDark}>
              Open wallet
            </Link>
          ) : (
            <>
              <Link href="/login" className={styles.btnText}>
                Log in
              </Link>
              <Link href="/signup" className={styles.btnDark}>
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <Logo />
          <p>A rupee wallet built on an append-only, double-entry ledger, so every balance can be checked, not just trusted.</p>
        </div>
        <div className={styles.footerCol}>
          <h3>Product</h3>
          <Link href="/#features">Features</Link>
          <Link href="/#security">Security</Link>
          <Link href="/#how-it-works">How it works</Link>
        </div>
        <div className={styles.footerCol}>
          <h3>Account</h3>
          <Link href="/login">Log in</Link>
          <Link href="/signup">Create account</Link>
          <Link href="/wallet">Your wallet</Link>
        </div>
      </div>
      <div className={styles.footerBottom}>
        <span>© {new Date().getFullYear()} Valoron. A demo project.</span>
        <span>Balances held in INR. Payments are simulated in this demo.</span>
      </div>
    </footer>
  );
}
