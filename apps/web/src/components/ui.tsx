import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "../lib/session";
export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width="28"
      height="32"
      viewBox="0 0 28 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 9 14 2l12 7v14l-12 7-12-7V9Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="m2 9 12 7 12-7M14 16v14M8 5.5v7l12 7v7M20 5.5v7l-12 7v7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
export function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <span aria-hidden="true">{diagonal ? "↗" : "→"}</span>;
}
export function Button({
  children,
  onClick,
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`button ${className}`}
    >
      {children}
    </button>
  );
}
export function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="error-box">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ) : null;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <Mark />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function useReducedMotion() {
  const [reduced, set] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => set(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}
export function Header({ active = "" }: { active?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="header">
      <a href="/" className="brand" aria-label="Bastion home">
        <Mark />
        bastion<span className="brand-period">.</span>
      </a>
      <button
        className="menu-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="navigation"
      >
        {open ? "Close" : "Menu"}
      </button>
      <nav
        id="navigation"
        className={open ? "nav open" : "nav"}
        aria-label="Main navigation"
      >
        <a href="/#security">Security</a>
        <a href="/arena" aria-current={active === "arena" ? "page" : undefined}>
          Arena <Arrow diagonal />
        </a>
        <a
          href="/architecture"
          aria-current={active === "architecture" ? "page" : undefined}
        >
          Architecture
        </a>
        <a
          href="/dashboard"
          className="button nav-cta"
          aria-current={active === "dashboard" ? "page" : undefined}
        >
          Open console <Arrow />
        </a>
      </nav>
    </header>
  );
}
export function Footer() {
  return (
    <footer className="footer">
      <a className="brand" href="/">
        <Mark />
        bastion.
      </a>
      <span>An agent workspace with security built in.</span>
      <a href="/architecture">
        Under the hood <Arrow diagonal />
      </a>
    </footer>
  );
}
export function Connect() {
  const { setToken } = useSession();
  const [value, setValue] = useState("");
  return (
    <div className="connect-panel">
      <span className="eyebrow">OPERATOR ACCESS</span>
      <h2>
        Your workspace.
        <br />
        <em>Your control.</em>
      </h2>
      <p>
        Connect with your operator token to see projects, workflows, and
        recorded security events.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) setToken(value.trim());
        }}
      >
        <label htmlFor="operator-token">Operator token</label>
        <input
          id="operator-token"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          autoComplete="off"
        />
        <Button type="submit">
          Connect workspace <Arrow />
        </Button>
      </form>
      <small>
        Held in memory for this visit. Never saved to browser storage.
      </small>
    </div>
  );
}
