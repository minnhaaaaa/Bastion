import { useEffect, useState } from "react";
import { Logo } from "./Logo";
export function Masthead({ active = "" }: { active?: string }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 60);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return (
    <header className={`mast ${scrolled || active ? "mast--ink" : ""}`}>
      <a href="/" className="mast__mark" aria-label="Bastion home">
        <Logo className="mast__logo" />
        bastion
      </a>
      <button
        className="mast__toggle"
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="primary-nav"
      >
        {open ? "×" : "☰"}
      </button>
      <nav
        id="primary-nav"
        className={`mast__nav ${open ? "mast__nav--open" : ""}`}
        aria-label="Primary"
      >
        <a href="/#security">security</a>
        <a
          href="/arena"
          aria-current={active === "arena" ? "page" : undefined}
          className={active === "arena" ? "is-active" : undefined}
        >
          arena
        </a>
        <a
          href="/architecture"
          aria-current={active === "architecture" ? "page" : undefined}
          className={active === "architecture" ? "is-active" : undefined}
        >
          architecture
        </a>
      </nav>
      <a className="mast__cta" href="/dashboard">
        <span className="dot" />
        console <span aria-hidden="true">↗</span>
      </a>
    </header>
  );
}
