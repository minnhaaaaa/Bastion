import KbdInputGroup from "./ui/kbd-input-group";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Masthead } from "./wenvy/Masthead";
import { useSession } from "../lib/session";
import { api, ApiRequestError } from "../lib/api";
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  return (
    <div className="connect-panel">
      <span className="eyebrow">OPERATOR ACCESS</span>
      <h2>Connect.</h2>
      <form
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          const candidate = value.trim();
          if (!candidate || request.current) return;
          const controller = new AbortController();
          request.current = controller;
          setPending(true);
          setError(null);
          try {
            // This endpoint requires an operator, so host/player tokens cannot open the workspace.
            await api("/api/projects", candidate, undefined, controller.signal);
            if (!controller.signal.aborted) setToken(candidate);
          } catch (failure) {
            if (!controller.signal.aborted) setError(
              failure instanceof ApiRequestError && [401, 403].includes(failure.status)
                ? new Error("Operator token not accepted.")
                : failure instanceof ApiRequestError ? failure : new Error("Cannot reach Bastion. Check the controller connection."),
            );
          } finally {
            request.current = null;
            if (!controller.signal.aborted) setPending(false);
          }
        }}
      >
        <label htmlFor="operator-token">Operator token</label>
        <KbdInputGroup
          icon={<KeyRound />}
          id="operator-token"
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          disabled={pending}
          aria-invalid={!!error}
          aria-describedby={error ? "connect-error" : undefined}
          required
          autoComplete="off"
        />
        <div id="connect-error"><ErrorBox error={error} /></div>
        <Button type="submit" disabled={pending || !value.trim()}>
          {pending ? "Connecting…" : "Open workspace"} <Arrow />
        </Button>
      </form>
    </div>
  );
}
