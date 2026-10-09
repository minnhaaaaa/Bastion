import { useRef, useState } from "react";
import { Emblem } from "../brand/Emblem";
import { gsap, useGSAP, ScrollTrigger, MOTION } from "../../lib/motion";

const LINKS = [
  { href: "/#threats", label: "Threats", key: "threats" },
  { href: "/arena", label: "Arena", key: "arena" },
  { href: "/architecture", label: "Architecture", key: "architecture" },
];

/** Rampart header: retracts on scroll down, returns on scroll up; solid once past the hero. */
export function SiteHeader({ active = "" }: { active?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useGSAP(
    () => {
      const el = ref.current!;
      const solid = ScrollTrigger.create({
        start: 40,
        end: "max",
        onToggle: (self) => el.classList.toggle("rampart-head--solid", self.isActive),
      });
      const mm = gsap.matchMedia();
      mm.add(MOTION, () => {
        gsap.from(el, { yPercent: -100, duration: 0.8, delay: 0.15 });
        const hide = gsap.to(el, { yPercent: -110, duration: 0.35, ease: "power2.out", paused: true });
        ScrollTrigger.create({
          start: 220,
          end: "max",
          onUpdate: (self) => (self.direction === 1 ? hide.play() : hide.reverse()),
          onLeaveBack: () => hide.reverse(),
        });
      });
      return () => {
        solid.kill();
        mm.revert();
      };
    },
    { scope: ref },
  );
  return (
    <header ref={ref} className={`rampart-head ${active ? "rampart-head--solid" : ""}`}>
      <a href="/" className="rampart-head__brand" aria-label="Bastion home">
        <Emblem className="rampart-head__emblem" />
        <span>Bastion</span>
      </a>
      <button
        className="rampart-head__toggle"
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="primary-nav"
      >
        <span />
        <span />
      </button>
      <nav id="primary-nav" className={`rampart-head__nav ${open ? "is-open" : ""}`} aria-label="Primary">
        {LINKS.map((l) => (
          <a key={l.key} href={l.href} aria-current={active === l.key ? "page" : undefined}>
            {l.label}
          </a>
        ))}
      </nav>
      <a className="btn rampart-head__cta" href="/dashboard">
        Console <span aria-hidden="true">↗</span>
      </a>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="rampart-foot">
      <div className="rampart-foot__crest">
        <Emblem className="rampart-foot__emblem" />
        <span>Bastion</span>
      </div>
      <p className="rampart-foot__motto">Trace · Contain · Recover</p>
      <nav aria-label="Footer">
        <a href="/dashboard">Console</a>
        <a href="/arena">Arena</a>
        <a href="/architecture">Architecture</a>
      </nav>
    </footer>
  );
}
