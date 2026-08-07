import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, NavLink, useLocation } from "react-router-dom";

const MotionLink = motion(Link);
import { ARC_EXPLORER, api, postInstruction, stageForEventType, type Stage, type WalletInfo } from "./api";
import { hasInjectedWallet } from "./wallet-connect";
import { useWallet } from "./wallet-context";
import { milestoneStates, parseBrief, type AgentEvent, type DecisionRow, type MilestoneState, type PaymentRow, type TaskRow } from "./types";
import { inkTransition, useCountUp, useFlashOnChange } from "./motion";
import {
  IconAlert,
  IconBolt,
  IconBrain,
  IconChevron,
  IconMap,
  IconMenu,
  IconMoon,
  IconPanelLeft,
  IconSun,
  IconTelegram,
  IconCheck,
  IconCoin,
  IconDot,
  IconFlag,
  IconGavel,
  IconLock,
  IconPen,
  IconScroll,
  IconSearch,
  IconShrug,
  IconSwords,
  IconX,
  type IconComponent,
} from "./Icon";

const SECUREFLOW_JOBS_URL = "https://secureflow-arc.vercel.app/jobs";
/** The second door. Exported because more than one page needs to point at it. */
export const TELEGRAM_BOT_URL = "https://t.me/PatronGuildbot";

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shorten(addr: string | null | undefined): string {
  if (!addr) return "—";
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

// Quiet on purpose. The previous entrance (y: -12 with a scale pop) read as
// springy app-chrome; ink appearing on paper shouldn't bounce. A short fade
// with a few pixels of lift is enough to show that a row is new.
export const cardMotion = {
  layout: true,
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  transition: inkTransition,
};

/**
 * A message you can put away.
 *
 * These used to sit there until some other action happened to replace them, so
 * a card carried "✓ Deposited — tx 0x759a…" long after it had been read, and
 * an error stayed on screen after you'd fixed the thing it was about.
 */
export function Notice({
  tone,
  onDismiss,
  children,
}: {
  tone: "ok" | "error" | "warn";
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`post-quest-msg ${tone} notice`}>
      <span className="notice-body">{children}</span>
      <button className="notice-x" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        <IconX size={13} />
      </button>
    </div>
  );
}

// ── Nav ──────────────────────────────────────────────────────────────────────
const COLLAPSE_KEY = "patron.sidebar.collapsed";

export function Nav({ connected }: { connected: boolean }) {
  // Named as sections of a guild's account book rather than as dashboard tabs.
  // Same routes, same data — the voice is what changes.
  //
  // The icons are not decoration. Collapsed, they are the ONLY thing left, so
  // each has to carry its section on its own: the brief a commission is written
  // on, the mind that judges it, the coin that settles it.
  const ledger = [
    { to: "/", label: "The Ledger", icon: IconMap, end: true },
    { to: "/jobs", label: "Open Commissions", icon: IconScroll },
    { to: "/decisions", label: "The Guild Master's Hand", icon: IconBrain },
    { to: "/payments", label: "Account of Monies", icon: IconCoin },
    { to: "/freelancers", label: "Register of Adventurers", icon: IconFlag },
    // Always here. This was gated twice — first on having spent something,
    // then on having a wallet connected — and both times the effect was a page
    // nobody could find. The page itself already answers every case: connect a
    // wallet, nothing commissioned yet, or the actual tracker. A nav item that
    // conditionally vanishes is harder to learn than one that is simply always
    // in the same place.
    { to: "/my-jobs", label: "Your Commissions", icon: IconCheck },
    { to: "/work", label: "Get Hired", icon: IconBolt },
  ];

  /**
   * Mobile drawer.
   *
   * A horizontally scrolling strip of routes is discoverable only if you
   * already know to swipe it — the labels run off the edge and nothing says
   * there is more. A hamburger is the one navigation idiom everyone has
   * already learned.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  // Any navigation closes it. A drawer that stays open over the page you just
  // asked for makes you dismiss it every single time.
  useEffect(() => setMenuOpen(false), [location.pathname]);
  // And so does Escape, because a drawer with no keyboard exit is a trap.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  // Remembered, because a rail that forgets is worse than one that never
  // collapsed: you set it once and it undoes itself on every navigation.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* private mode — the preference just won't survive the session */
    }
    // The grid column lives on the shell, which is a parent, so the flag has to
    // reach it through the DOM rather than through props.
    document.documentElement.dataset.rail = collapsed ? "collapsed" : "open";
  }, [collapsed]);

  return (
    <>
    {/* Backdrop. Tapping anywhere off the drawer closes it — the second
        universally-understood half of this pattern. */}
    {menuOpen && <div className="drawer-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
    <aside className={`sidebar ${collapsed ? "collapsed" : ""} ${menuOpen ? "menu-open" : ""}`}>
      {/* The collapse control belongs HERE, level with the brand, where every
          other application puts it and where the eye already is. Buried at the
          bottom of the rail it was below the fold on a short window and read as
          a footer link rather than a control. */}
      <div className="sidebar-head">
        <NavLink to="/" className="sidebar-brand" title="Patron">
          <img src="/patron-logo.svg" alt="" className="logo" />
          <div className="sidebar-brand-text">
            <div className="nav-title">PATRON</div>
            <div className="nav-subtitle">the human-labor endpoint of the agent economy</div>
          </div>
        </NavLink>
        <button
          className="rail-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <IconPanelLeft size={17} />
        </button>
        {/* Mobile only — the rail toggle has nothing to collapse at that size. */}
        <button
          className="menu-toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
        >
          {menuOpen ? <IconX size={20} /> : <IconMenu size={20} />}
        </button>
      </div>

      <nav className="sidebar-links">
        {ledger.map((l, i) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            title={collapsed ? l.label : undefined}
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
            // A short stagger on first paint so the rail assembles rather than
            // appearing. Index-delayed, tiny, and never on navigation.
            style={{ animationDelay: `${i * 34}ms` }}
          >
            <span className="nav-link-icon">
              <l.icon size={16} />
            </span>
            <span className="nav-link-label">{l.label}</span>
            {collapsed && <span className="nav-tip">{l.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Pinned to the bottom of the rail — the connection state and the second
          door are both persistent facts about the app rather than places to go,
          so they sit apart from the routes. */}
      <div className="sidebar-foot">
        {/* The bot is a real second door into the product, not a footnote — it
            gets the brand colour and a border so it reads as somewhere to go. */}
        <a
          className="tg-rail"
          href={TELEGRAM_BOT_URL}
          target="_blank"
          rel="noreferrer"
          title={collapsed ? "Patron on Telegram" : undefined}
        >
          <span className="nav-link-icon">
            <IconTelegram size={16} />
          </span>
          <span className="nav-link-label">Telegram bot</span>
          {collapsed && <span className="nav-tip">Telegram bot</span>}
        </a>

        <div className="sidebar-foot-row">
          <div className="status" title={connected ? "Live" : "Disconnected"}>
            <span className={`dot ${connected ? "live" : ""}`} />
            <span className="nav-link-label">{connected ? "Live" : "Disconnected"}</span>
          </div>
          <ThemeToggle collapsed={collapsed} />
        </div>
      </div>
    </aside>
    </>
  );
}

/**
 * Light and dark.
 *
 * The dark side is the product's own voice — gold on near-black. The light side
 * is deliberately NOT white: this thing is a ledger, so it goes to parchment,
 * and the gold darkens to keep its contrast against it. Both are the same
 * design rather than one design and its inversion.
 *
 * The chosen theme is written to the root element and read back by an inline
 * script before React mounts, so a reload never flashes the other one.
 */
const THEME_KEY = "patron.theme";

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = window.localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
      return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="theme-toggle"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />}
      {!collapsed && <span className="nav-link-label">{theme === "dark" ? "Light" : "Dark"}</span>}
    </button>
  );
}

// ── Pipeline ─────────────────────────────────────────────────────────────────
const STAGES: { key: Stage; icon: IconComponent; label: string }[] = [
  { key: "intake", icon: IconScroll, label: "Client Instructs" },
  { key: "brief", icon: IconBrain, label: "Brief Generated" },
  { key: "escrow", icon: IconLock, label: "Locked in Escrow" },
  { key: "applicants", icon: IconSwords, label: "Humans Apply" },
  { key: "review", icon: IconSearch, label: "Work Reviewed" },
  { key: "payout", icon: IconCoin, label: "USDC Released" },
];

function highestStageIndex(tasks: TaskRow[], decisions: DecisionRow[], payments: PaymentRow[]): number {
  let idx = tasks.length > 0 ? 0 : -1;
  if (tasks.some((t) => t.briefJson)) idx = Math.max(idx, 1);
  if (tasks.some((t) => t.escrowId)) idx = Math.max(idx, 2);
  if (decisions.some((d) => ["application_scored", "applicant_accepted", "no_suitable_applicant", "portfolio_verified"].includes(d.type)))
    idx = Math.max(idx, 3);
  if (decisions.some((d) => ["work_approved", "work_rejected", "revision_requested", "escalated_to_human", "escalated"].includes(d.type)))
    idx = Math.max(idx, 4);
  if (payments.some((p) => p.direction === "escrow_release")) idx = Math.max(idx, 5);
  return idx;
}

export function PipelineFlow({
  tasks,
  decisions,
  payments,
  lastEvent,
}: {
  tasks: TaskRow[];
  decisions: DecisionRow[];
  payments: PaymentRow[];
  lastEvent: AgentEvent | null;
}) {
  const [pulseKey, setPulseKey] = useState<Stage | null>(null);
  const reached = highestStageIndex(tasks, decisions, payments);

  useEffect(() => {
    if (!lastEvent) return;
    const stage = stageForEventType(lastEvent.type);
    if (!stage) return;
    setPulseKey(stage);
    const t = setTimeout(() => setPulseKey(null), 2600);
    return () => clearTimeout(t);
  }, [lastEvent]);

  return (
    <div className="flow">
      {STAGES.map((s, i) => (
        <div className="flow-stage" key={s.key}>
          <motion.div
            className={`flow-node ${i <= reached ? "lit" : ""} ${pulseKey === s.key ? "pulsing" : ""}`}
            // A completed stage swells once and settles. Deliberately understated:
            // the old 1.12 pop on a 42px circle read as a UI toy, and this diagram
            // is the spine of the demo — it should feel like a stamp landing.
            animate={pulseKey === s.key ? { scale: [1, 1.07, 1] } : { scale: 1 }}
            transition={{ duration: 0.55, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <s.icon size={19} />
          </motion.div>
          <div className={`flow-label ${i <= reached ? "lit" : ""}`}>{s.label}</div>
          {i < STAGES.length - 1 && (
            // The connector DRAWS toward the next stage rather than switching
            // colour, so progress reads as travel along the line.
            <div className="flow-line">
              <motion.div
                className="flow-line-fill"
                initial={false}
                animate={{ scaleX: i < reached ? 1 : 0 }}
                transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Stats ────────────────────────────────────────────────────────────────────
export function StatsBar({ tasks, payments }: { tasks: TaskRow[]; payments: PaymentRow[] }) {
  // "failed" jobs never opened an escrow at all (the LLM call or createEscrow
  // threw), so they aren't commissions and don't belong in any of these counts.
  const real = tasks.filter((t) => t.status !== "failed");
  const totalJobs = real.length;
  const active = real.filter((t) => t.status === "posted" || t.status === "active" || t.status === "briefing").length;
  const completed = real.filter((t) => t.status === "completed").length;
  const disputed = real.filter((t) => t.status === "disputed").length;
  const released = payments
    .filter((p) => p.direction === "escrow_release" && p.amount_usdc)
    .reduce((sum, p) => sum + parseFloat(p.amount_usdc || "0"), 0);

  // Of the jobs that actually reached a conclusion, how many finished cleanly.
  // Dividing by ALL jobs (the old behaviour) counts everything still in flight
  // as a failure, which permanently pins the number near zero and says nothing
  // true about how well the agent performs.
  const concluded = completed + disputed;
  const completionRate = concluded > 0 ? Math.round((completed / concluded) * 100) : 0;

  const animatedReleased = useCountUp(released);
  const releasedFlash = useFlashOnChange(released);

  // Deliberate hierarchy, not four equal boxes: money actually paid to humans
  // is the entire point of the project, so it is set enormous and everything
  // else is small. Uniform mid-sized stat cards are the clearest tell of a
  // generated layout — this is the opposite on purpose.
  const rest = [
    { label: "Commissions", value: totalJobs.toString() },
    { label: "In Progress", value: active.toString() },
    { label: "Completed", value: completed.toString() },
    ...(disputed > 0 ? [{ label: "With Arbiter", value: disputed.toString() }] : []),
    { label: concluded > 0 ? "Completed Cleanly" : "Completion Rate", value: `${completionRate}%` },
  ];

  return (
    <div className="stats">
      <div className="stat stat-hero">
        {/* Counts toward its new value when an escrow releases. This is the one
            number the whole project is about — a judge who misses it climbing
            has missed the payment happening. */}
        <div className={`stat-value ${releasedFlash ? "stat-value-flash" : ""}`}>${animatedReleased.toFixed(2)}</div>
        <div className="stat-label">paid to humans, on-chain</div>
      </div>
      <div className="stat-rest">
        {rest.map((s) => (
          <div className="stat" key={s.label}>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Treasury (+ real wallet-connect funding) ─────────────────────────────────
export function Treasury({ wallet, onFunded }: { wallet: WalletInfo | null; onFunded: () => void }) {
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState("5");
  const [fundedTx, setFundedTx] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [withdrewTx, setWithdrewTx] = useState<string | null>(null);
  // Remembered. This card is reference material once you know your numbers, and
  // a panel that re-opens itself on every navigation is one you end up closing
  // over and over.
  const [accountOpen, setAccountOpen] = useState(() => {
    try {
      return window.localStorage.getItem("patron.account.collapsed") !== "1";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("patron.account.collapsed", accountOpen ? "0" : "1");
    } catch {
      /* private mode */
    }
  }, [accountOpen]);

  // ONE shared connection — see wallet-context.tsx. Calling useWalletConnect()
  // here directly is what let a commission post itself anonymously.
  const {
    address,
    balance: walletBalance,
    connecting,
    funding,
    error,
    connect,
    fund,
    setError,
    account,
    refreshAccount,
    signMessage,
  } = useWallet();

  const balance = wallet ? parseFloat(wallet.balance) : 0;
  const animatedBalance = useCountUp(balance);
  const balanceFlash = useFlashOnChange(wallet ? wallet.balance : null);

  const myWalletBalance = walletBalance != null ? parseFloat(walletBalance) : null;
  const insufficient = myWalletBalance != null && amount !== "" && parseFloat(amount) > myWalletBalance;
  const withdrawable = account ? parseFloat(account.withdrawable) : 0;

  function copy() {
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleFund() {
    if (!wallet) return;
    setFundedTx(null);
    const hash = await fund(wallet.address, amount);
    if (!hash) return;
    setFundedTx(hash);
    onFunded();
    if (address) {
      try {
        // Credited only after the daemon re-reads this transaction on Arc.
        await api(`/api/treasury/deposit`, { method: "POST", body: JSON.stringify({ txHash: hash, from: address }) });
      } catch {
        /* the funds landed; attribution can be retried */
      }
      await refreshAccount();
    }
  }

  async function handleWithdraw() {
    if (!address || !account) return;
    const amt = Number(withdrawAmt);
    if (!(amt > 0)) return;
    if (amt > withdrawable) {
      setError(`You can withdraw at most $${withdrawable.toFixed(2)} right now.`);
      return;
    }
    setWithdrawing(true);
    setWithdrewTx(null);
    try {
      const amountUsdc = amt.toFixed(6);
      const message = `Patron treasury withdrawal\nAddress: ${address.toLowerCase()}\nAmount: ${amountUsdc} USDC`;
      const signature = await signMessage(message);
      if (!signature) return;
      const r = await api<{ txHash: string }>(`/api/treasury/withdraw`, {
        method: "POST",
        body: JSON.stringify({ address, amountUsdc, signature, message }),
      });
      setWithdrewTx(r.txHash);
      setWithdrawAmt("");
      onFunded();
      await refreshAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <>
      {/* Patron's own position. Global, read-only, and nothing to do with who
          is looking at it — so it stays its own row. */}
      <div className="treasury">
        <div className="treasury-main">
          <div className="treasury-label">Patron's Treasury</div>
          <div className={`treasury-balance ${balanceFlash ? "stat-value-flash" : ""}`}>
            {wallet ? `$${animatedBalance.toFixed(2)}` : "—"}
          </div>
          <div className="treasury-sub">available to fund new jobs</div>
        </div>

        <div className="treasury-fund">
          <div className="treasury-fund-label">Fund it</div>
          <div className="treasury-address-row">
            <code className="treasury-address">{wallet ? wallet.address : "…"}</code>
            <button className="treasury-copy" onClick={copy} disabled={!wallet}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          {wallet && (
            <a className="tx-link" href={wallet.explorerUrl} target="_blank" rel="noreferrer">
              view balance &amp; history on Arcscan ↗
            </a>
          )}
        </div>

        <div className="treasury-connect">
          {!hasInjectedWallet() ? (
            <div className="treasury-fund-label">No browser wallet detected — send funds to the address instead.</div>
          ) : !address ? (
            <button className="treasury-connect-btn" onClick={connect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect Wallet"}
            </button>
          ) : (
            <div className="wallet-chip">
              <span className="dot live" />
              <code>{shorten(address)}</code>
              {myWalletBalance != null && <span className="wallet-chip-bal">${myWalletBalance.toFixed(2)}</span>}
            </div>
          )}
        </div>
      </div>

      {/* The visitor's OWN account. A separate card, because it is a different
          subject entirely — cramming it into the treasury row made one panel
          answer two unrelated questions and read as clutter. */}
      {address && (
        <div className="account-card">
          <div className="account-head">
            <h3>Your account</h3>
            {accountOpen ? (
              <span className="account-sub">money you put in, what you've committed, and what you can take back</span>
            ) : (
              // Collapsed, the one number worth keeping on screen is what you can
              // still spend or withdraw — hiding that would make the card feel
              // closed rather than tidied.
              <span className="account-sub">
                <b className="account-collapsed-figure">${account ? parseFloat(account.claim).toFixed(2) : "0.00"}</b>{" "}
                available
              </span>
            )}
            <button
              className="account-toggle"
              onClick={() => setAccountOpen((v) => !v)}
              aria-expanded={accountOpen}
              title={accountOpen ? "Collapse" : "Expand"}
            >
              <IconChevron size={16} className={accountOpen ? "flip" : ""} />
            </button>
          </div>

          {accountOpen && (
          <>

          <div className="account-grid">
            <div className="account-figure">
              <span className="account-figure-label">Deposited</span>
              <b>${account ? parseFloat(account.deposited).toFixed(2) : "0.00"}</b>
            </div>
            <div className="account-figure">
              <span className="account-figure-label">Committed to jobs</span>
              <b>${account ? parseFloat(account.spent).toFixed(2) : "0.00"}</b>
            </div>
            <div className="account-figure">
              <span className="account-figure-label">Withdrawn</span>
              <b>${account ? parseFloat(account.withdrawn).toFixed(2) : "0.00"}</b>
            </div>
            <div className="account-figure primary">
              <span className="account-figure-label">Available</span>
              <b>${account ? parseFloat(account.claim).toFixed(2) : "0.00"}</b>
            </div>
          </div>

          <div className="account-actions">
            <div className="account-action">
              <label>Deposit</label>
              <div className="treasury-fund-row">
                <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <button className="treasury-connect-btn" onClick={handleFund} disabled={funding || !wallet || insufficient}>
                  {funding ? "Sending…" : "Deposit"}
                </button>
              </div>
              {myWalletBalance != null && (
                <div className={`account-hint ${insufficient ? "short" : ""}`}>
                  {insufficient
                    ? `More than the $${myWalletBalance.toFixed(2)} in your wallet`
                    : `$${myWalletBalance.toFixed(2)} in your wallet`}
                </div>
              )}
            </div>

            <div className="account-action">
              <label>Withdraw</label>
              <div className="treasury-fund-row">
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder={withdrawable.toFixed(2)}
                  value={withdrawAmt}
                  onChange={(e) => setWithdrawAmt(e.target.value)}
                  disabled={withdrawable <= 0}
                />
                <button
                  className="treasury-connect-btn"
                  onClick={handleWithdraw}
                  disabled={withdrawing || !withdrawAmt || withdrawable <= 0}
                >
                  {withdrawing ? "Signing…" : "Withdraw"}
                </button>
              </div>
              <div className="account-hint">
                {withdrawable > 0 ? `$${withdrawable.toFixed(2)} available now` : "Nothing to withdraw yet"}
              </div>
            </div>
          </div>

          {account && parseFloat(account.withdrawable) < parseFloat(account.claim) && (
            <div className="depositor-note">
              ${parseFloat(account.claim).toFixed(2)} is yours, but only ${parseFloat(account.withdrawable).toFixed(2)} is in
              the treasury right now — the rest is locked in escrow against live commissions, and frees up as they settle.
            </div>
          )}

          </>
          )}

          {/* Receipts stay until dismissed rather than until something else
              happens to replace them — but they have to be dismissible, or the
              card carries a stale "✓ Deposited" long after you've read it. */}
          {error && <Notice tone="error" onDismiss={() => setError("")}>⚠ {error}</Notice>}
          {fundedTx && (
            <Notice tone="ok" onDismiss={() => setFundedTx(null)}>
              ✓ Deposited —{" "}
              <a className="tx-link" href={`${ARC_EXPLORER}/tx/${fundedTx}`} target="_blank" rel="noreferrer">
                tx {shorten(fundedTx)} ↗
              </a>
            </Notice>
          )}
          {withdrewTx && (
            <Notice tone="ok" onDismiss={() => setWithdrewTx(null)}>
              ✓ Withdrawn —{" "}
              <a className="tx-link" href={`${ARC_EXPLORER}/tx/${withdrewTx}`} target="_blank" rel="noreferrer">
                tx {shorten(withdrewTx)} ↗
              </a>
            </Notice>
          )}
        </div>
      )}
    </>
  );
}


// ── Post a quest ─────────────────────────────────────────────────────────────
export function PostQuest({ onPosted }: { onPosted: () => void }) {
  // The SHARED connection. Reading it from its own useWalletConnect() is what
  // let a $5 depositor commission out of the pooled treasury: this component
  // held a second, never-connected copy, so it sent no signature and the
  // server's cap was never consulted.
  const { address, signMessage, connecting, connect, account, refreshAccount } = useWallet();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState("");
  const [days, setDays] = useState("3");
  // "auto" leaves the decision to the guild master, which is the right default —
  // it already splits work that naturally decomposes. But a client who WANTED
  // staged payments had no way to ask for it: the form collected a description,
  // a budget and a duration, and nothing else reached the brief.
  const [stages, setStages] = useState<"auto" | "1" | "2" | "3">("auto");
  // How long applications stay open before they're judged together.
  //
  // The daemon's default is 3 minutes, which is right for an automated test and
  // far too short for a person: by the time a freelancer sees the job, reads the
  // brief and writes a cover letter, the window has closed and they are scored
  // alone — the exact first-come race the window exists to prevent. Job #55 was
  // posted with no window and closed before anyone could apply.
  const [window_, setWindow] = useState<"5" | "30" | "120" | "1440">("30");
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [result, setResult] = useState<{ taskId: string; escrowId: string } | null>(null);
  const [error, setError] = useState("");

  // One ceiling now: your own deposit. Commissioning is no longer possible
  // without a wallet, so there is no second, looser path to fall through to.
  const myClaim = account ? parseFloat(account.claim) : 0;
  const overBudget = budget !== "" && parseFloat(budget) > myClaim;
  const canSubmit =
    description.trim() !== "" &&
    budget !== "" &&
    parseFloat(budget) > 0 &&
    days !== "" &&
    status !== "loading" &&
    !overBudget &&
    !!address;

  async function submit() {
    if (!canSubmit) return;
    setStatus("loading");
    setError("");
    // Folded into the INSTRUCTION rather than passed as a separate field, on
    // purpose. The whole pipeline is "instruction in, enforceable brief out",
    // and the guild master already knows how to split work and make the parts
    // sum to the budget. Handing it a structured override would mean a second
    // way to build a brief that skips every check the first one runs.
    const staging =
      stages === "auto"
        ? ""
        : stages === "1"
          ? " Deliver this as a single milestone paid on completion."
          : ` Split this into ${stages} milestones that are each reviewed and paid separately.`;
    const WINDOW_PHRASE: Record<string, string> = {
      "5": " Give people 5 minutes to apply before choosing.",
      "30": " Give people 30 minutes to apply before choosing.",
      "120": " Give people 2 hours to apply before choosing.",
      "1440": " Leave applications open for 24 hours before choosing.",
    };
    const instruction = `${title.trim() ? title.trim() + " — " : ""}${description.trim()}. Budget $${budget}, ${days} day(s).${staging}${WINDOW_PHRASE[window_] ?? ""}`;
    try {
      // Signed when a depositor is spending their own deposit — the server
      // verifies it and refuses anything above their remaining claim. Without a
      // wallet this is the anonymous demo path and stays as it was.
      if (!address) {
        setError("Connect your wallet to commission work.");
        setStatus("error");
        return;
      }
      // Signed, always. The server verifies it and refuses anything above this
      // address's remaining deposit.
      const amountUsdc = Number(budget).toFixed(6);
      const message = `Patron commission\nAddress: ${address.toLowerCase()}\nBudget: ${amountUsdc} USDC`;
      const signature = await signMessage(message);
      if (!signature) {
        setStatus("idle");
        return;
      }
      const res = await postInstruction(instruction, { clientAddress: address, signature, message }, title.trim() || undefined);
      void refreshAccount();
      setResult(res);
      setStatus("done");
      setTitle("");
      setDescription("");
      setBudget("");
      setDays("3");
      setStages("auto");
      setWindow("30");
      onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  // Not connected: don't render a form that cannot succeed. Commissioning
  // spends real money from a real account, so the first step is having one.
  if (!address) {
    return (
      <div className="post-quest">
        <div className="post-quest-label">Commission work</div>
        <p className="post-quest-gate">
          Connect a wallet to hire through Patron. You deposit what you want to spend, commission against it, and
          withdraw whatever you don't use — no job can ever exceed your own balance.
        </p>
        <div className="post-quest-fields" style={{ marginTop: 16 }}>
          <button onClick={connect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect wallet →"}
          </button>
        </div>
      </div>
    );
  }

  // Connected but nothing deposited yet.
  if (myClaim <= 0) {
    return (
      <div className="post-quest">
        <div className="post-quest-label">Commission work</div>
        <p className="post-quest-gate">
          You're connected as <code>{shorten(address)}</code>, with nothing deposited yet. Add funds in{" "}
          <b>Your account</b> above and you can commission immediately — anything you don't spend is withdrawable at any
          time.
        </p>
      </div>
    );
  }

  return (
    <div className="post-quest">
      <div className="post-quest-label">Commission work</div>

      <input
        className="post-quest-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Job title — e.g. Coffee shop logo (kept exactly as you write it)"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What do you need? Be specific — this becomes the acceptance brief."
        rows={2}
      />

      <div className="post-quest-fields">
        <label className="post-quest-field">
          <span>Budget (USDC)</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="50"
          />
        </label>
        <label className="post-quest-field">
          <span>Duration (days)</span>
          <input type="number" min="1" step="1" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <label className="post-quest-field">
          <span>Applications open</span>
          <select value={window_} onChange={(e) => setWindow(e.target.value as typeof window_)}>
            <option value="5">5 minutes (demo)</option>
            <option value="30">30 minutes</option>
            <option value="120">2 hours</option>
            <option value="1440">24 hours</option>
          </select>
        </label>
        <label className="post-quest-field">
          <span>Pay in stages</span>
          <select value={stages} onChange={(e) => setStages(e.target.value as typeof stages)}>
            <option value="auto">Let Patron decide</option>
            <option value="1">One payment</option>
            <option value="2">2 milestones</option>
            <option value="3">3 milestones</option>
          </select>
        </label>
        <button onClick={submit} disabled={!canSubmit}>
          {status === "loading" ? "Posting…" : "Post Quest →"}
        </button>
      </div>

      {stages !== "auto" && stages !== "1" && (
        <div className="post-quest-hint">
          Patron will write the {stages} stages and split the budget between them — each one is reviewed and paid on its
          own, so a freelancer is never asked to finish everything before seeing any money.
        </div>
      )}

      <div className="post-quest-hint">
        Applications stay open for the window you choose, then the guild master reads every applicant{" "}
        <b>together</b> and ranks them against each other — so the job doesn't go to whoever refreshed fastest.
      </div>
      <div className="post-quest-hint">
        Commissioned against your own deposit — <b>${myClaim.toFixed(2)}</b> available. Whatever you don't spend stays
        withdrawable, and a job nobody suitable applies for is refunded in full.
      </div>
      {overBudget && (
        <div className="post-quest-msg warn">
          ⚠ That's more than the ${myClaim.toFixed(2)} you have left. Lower the budget, or deposit more above.
        </div>
      )}
      {status === "error" && <div className="post-quest-msg error">⚠ {error}</div>}
      {status === "done" && result && (
        <div className="post-quest-msg ok">
          ✓ Posted — escrow #{result.escrowId}.{" "}
          {/* Point them at THEIR job, not at the room. "Watch the panels below"
              asked a client to find their own commission in a shared firehose;
              the page that tracks this one job — applicants, every decision,
              and the delivered file when it lands — is one link away. */}
          <Link className="tx-link" to={`/jobs/${result.escrowId}`}>
            Track it here ↗
          </Link>{" "}
          — applicants, the guild master's reasoning, and your finished file when it arrives.
        </div>
      )}
    </div>
  );
}

// ── Live notification center (every event type, not just injection) ─────────
const EVENT_ICON: Record<string, IconComponent> = {
  brief_generated: IconBrain,
  job_posted: IconLock,
  applications_fetched: IconScroll,
  application_scored: IconSwords,
  applicant_accepted: IconCheck,
  no_suitable_applicant: IconShrug,
  portfolio_verified: IconSearch,
  work_submitted: IconPen,
  work_approved: IconCheck,
  work_rejected: IconPen,
  revision_requested: IconPen,
  escalated_to_human: IconGavel,
  payment_released: IconCoin,
  task_completed: IconFlag,
};

export function NotificationCenter({ liveEvents }: { liveEvents: AgentEvent[] }) {
  const [visible, setVisible] = useState<(AgentEvent & { key: string })[]>([]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const fresh = liveEvents[0];
    if (!fresh) return;
    const key = `${fresh.type}-${fresh.timestamp}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    setVisible((prev) => [{ ...fresh, key }, ...prev].slice(0, 4));
    const t = setTimeout(() => setVisible((prev) => prev.filter((e) => e.key !== key)), 6000);
    return () => clearTimeout(t);
  }, [liveEvents[0]]);

  const isInjection = (e: AgentEvent) => e.decision?.reasoning?.includes("[PROMPT INJECTION DETECTED]");

  return (
    <div className="toast-stack">
      <AnimatePresence>
        {visible.map((e) => {
          const EventIcon = EVENT_ICON[e.type] ?? IconDot;
          return (
            <motion.div
              key={e.key}
              className={`toast ${isInjection(e) ? "toast-alert" : "toast-info"}`}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
            >
              <span className="toast-icon">{isInjection(e) ? <IconAlert size={16} /> : <EventIcon size={16} />}</span>
              <span>
                {isInjection(e) ? (
                  <>
                    <b>Prompt injection blocked</b> — applicant scored near-zero and rejected automatically.
                  </>
                ) : (
                  e.message
                )}
              </span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ── Shared cards ─────────────────────────────────────────────────────────────
export function TaskCard({ task, linkToDetail = true }: { task: TaskRow; linkToDetail?: boolean }) {
  const brief = parseBrief(task);
  // Every commission carries a ledger entry number — the escrow id, zero-padded
  // like a folio. It's the same number that's on-chain, so a judge can read it
  // here and find it on Arcscan.
  const entryNo = task.escrowId ? task.escrowId.padStart(4, "0") : null;
  const inner = (
    <>
      <div className="card-row">
        <span>
          {entryNo && <span className="entry-no">ENTRY {entryNo}&nbsp;&nbsp;·&nbsp;&nbsp;</span>}
          <span className={`badge ${task.clientType}`}>{task.clientType === "agent" ? "AI Agent" : "Human"}</span>
        </span>
        <span className={`badge status-${task.status}`}>{task.status}</span>
      </div>
      <div className="card-title">{brief?.title ?? task.instruction}</div>
      {brief && (
        <div className="card-milestones-preview">
          {brief.milestones.length} milestone{brief.milestones.length !== 1 ? "s" : ""} · ${brief.budget} total
        </div>
      )}
      <div className="card-row" style={{ marginTop: 8, marginBottom: 0 }}>
        <span>{timeAgo(task.createdAt)}</span>
        {task.escrowId && <span className="tx-link">read the entry →</span>}
      </div>
    </>
  );
  return linkToDetail && task.escrowId ? (
    <MotionLink className="card card-link" to={`/jobs/${task.escrowId}`} {...cardMotion}>
      {inner}
    </MotionLink>
  ) : (
    <motion.div className="card" {...cardMotion}>
      {inner}
    </motion.div>
  );
}

export function DecisionCard({ decision }: { decision: DecisionRow }) {
  const isInjection = decision.reasoning.includes("[PROMPT INJECTION DETECTED]");
  return (
    <motion.div className={`card ${isInjection ? "card-alert" : ""}`} {...cardMotion}>
      <div className="card-row">
        <span className="badge">{decision.type.replace(/_/g, " ")}</span>
        {decision.score != null && <span className="amount">{decision.score}/100</span>}
      </div>
      <div className={`card-reasoning ${isInjection ? "injection" : ""}`}>{decision.reasoning}</div>
      {decision.target && (
        <div className="card-row" style={{ marginTop: 6, marginBottom: 0 }}>
          {shorten(decision.target)}
        </div>
      )}
    </motion.div>
  );
}

export function PaymentCard({ payment }: { payment: PaymentRow }) {
  const label: Record<PaymentRow["direction"], string> = {
    in: "Robot → Patron",
    out: "Patron → Service",
    escrow_lock: "Locked in Escrow",
    escrow_release: "Escrow → Human",
  };
  return (
    <motion.div className="card" {...cardMotion}>
      <div className="card-row">
        <span className={`badge direction-${payment.direction}`}>{label[payment.direction]}</span>
        <span className="amount">{payment.amount_usdc ? `$${payment.amount_usdc}` : ""}</span>
      </div>
      <div className="card-row" style={{ marginBottom: 0 }}>
        <span>{timeAgo(payment.timestamp)}</span>
        {payment.tx_hash && (
          <a className="tx-link" href={`${ARC_EXPLORER}/tx/${payment.tx_hash}`} target="_blank" rel="noreferrer">
            view tx ↗
          </a>
        )}
      </div>
    </motion.div>
  );
}

const MILESTONE_LABEL: Record<MilestoneState, string> = {
  paid: "Paid",
  in_review: "In review",
  pending: "Pending",
};

const MILESTONE_ICON: Record<MilestoneState, IconComponent> = {
  paid: IconCheck,
  in_review: IconSearch,
  pending: IconDot,
};

export function MilestoneList({ task, payments }: { task: TaskRow; payments: PaymentRow[] }) {
  const brief = parseBrief(task);
  if (!brief) return <div className="empty">No brief yet.</div>;
  const states = milestoneStates(task, payments);

  return (
    <div className="milestones">
      {brief.milestones.map((m, i) => {
        const StateIcon = MILESTONE_ICON[states[i]];
        return (
          <div className={`milestone milestone-${states[i]}`} key={i}>
            <div className="milestone-index">{i + 1}</div>
            <div className="milestone-body">
              <div className="milestone-desc">{m.description}</div>
              <div className="milestone-meta">
                <span className="amount">${m.amount}</span>
                <span className={`milestone-state milestone-state-${states[i]}`}>
                  <StateIcon size={13} /> {MILESTONE_LABEL[states[i]]}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { SECUREFLOW_JOBS_URL };

// ── Pagination ───────────────────────────────────────────────────────────────
// Extracted after the second page needed it. The ledger pages all have the same
// shape of problem — an unbounded list that used to be short — but NOT the same
// solution: decisions, payments and commissions are paged by the server because
// they grow without limit, while the freelancer register is derived in the
// browser from three other feeds and has to be paged here. One control, three
// call sites, three different sources.

/** A short window of page numbers around the current one, with gaps. */
export function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const out: (number | null)[] = [0];
  const from = Math.max(1, current - 1);
  const to = Math.min(total - 2, current + 1);
  if (from > 1) out.push(null);
  for (let p = from; p <= to; p++) out.push(p);
  if (to < total - 2) out.push(null);
  out.push(total - 1);
  return out;
}

export function Pager({
  page,
  pages,
  onPage,
  busy = false,
  newestLabel = "Newer",
  oldestLabel = "Older",
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
  busy?: boolean;
  newestLabel?: string;
  oldestLabel?: string;
}) {
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button className="pager-btn" onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0 || busy}>
        ← {newestLabel}
      </button>
      <div className="pager-pages">
        {pageWindow(page, pages).map((p, i) =>
          p === null ? (
            <span key={`gap-${i}`} className="pager-gap">
              …
            </span>
          ) : (
            <button
              key={p}
              className={`pager-num ${p === page ? "current" : ""}`}
              onClick={() => onPage(p)}
              disabled={busy}
              aria-current={p === page ? "page" : undefined}
            >
              {p + 1}
            </button>
          ),
        )}
      </div>
      <button className="pager-btn" onClick={() => onPage(Math.min(pages - 1, page + 1))} disabled={page >= pages - 1 || busy}>
        {oldestLabel} →
      </button>
    </div>
  );
}

/** "1–20 of 98", or nothing when there is nothing to count. */
export function PageCount({ page, size, total }: { page: number; size: number; total: number }) {
  if (total <= 0) return null;
  return (
    <span className="page-count">
      {page * size + 1}–{Math.min((page + 1) * size, total)} of {total}
    </span>
  );
}

/**
 * How long applications stay open, counting down.
 *
 * The freelancer board always showed this; the client — the person who paid,
 * and the one actually waiting on a decision — was shown nothing at all. They
 * had no way to know whether the silence meant "still collecting applicants" or
 * "something is broken", which are very different feelings about your money.
 *
 * Ticks every second rather than on render, because a countdown that only moves
 * when something else happens to change is worse than no countdown.
 */
export function JudgingCountdown({ closesAt, applicants }: { closesAt: number; applicants: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const ms = closesAt - now;
  const open = ms > 0;

  const left = (() => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
    return `${sec}s`;
  })();

  return (
    <div className={`judging ${open ? "open" : "closed"}`}>
      <div className="judging-head">
        <IconSearch size={15} />
        {open ? "Applications close in" : "Applications closed"}
      </div>
      {open ? (
        <>
          <div className="judging-clock">{left}</div>
          <div className="judging-note">
            {applicants === 0
              ? "No applicants yet. When the window closes the guild master reads everyone together and ranks them against each other — so nothing is decided first-come."
              : `${applicants} applicant${applicants === 1 ? "" : "s"} so far. They're judged together when the window closes, not as they arrive.`}
          </div>
        </>
      ) : (
        <div className="judging-note">
          {applicants === 0
            ? "The window has passed with nobody applying, so the next person to apply is scored on their own. If none reach the bar by the deadline, the budget is refunded in full."
            : "Judged. Every score and the reasoning behind it is on the guild master's page."}
        </div>
      )}
    </div>
  );
}
