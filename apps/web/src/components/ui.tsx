import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "./wenvy/Logo";
import { Masthead } from "./wenvy/Masthead";
import { useSession } from "../lib/session";
export function Mark({ className = "" }: { className?: string }) {
  return <Logo className={className} />;
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
export function Empty({ title }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Mark />
      <h3>{title}</h3>
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
  return <Masthead active={active} />;
}
export function Footer() {
  return (
    <footer className="foot">
      <a href="/" className="foot__mark">
        <Logo className="foot__logo" />
        bastion
      </a>
      <span className="foot__note">trace · contain · recover</span>
      <a href="/architecture">architecture ↗</a>
    </footer>
  );
}
export function Connect() {
  const { setToken } = useSession();
  const [value, setValue] = useState("");
  return (
    <div className="connect-panel">
      <span className="eyebrow">OPERATOR ACCESS</span>
      <h2>Connect.</h2>
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
          Open workspace <Arrow />
        </Button>
      </form>
    </div>
  );
}
