import { useRef } from "react";
import { Header, Footer } from "../components/ui";
import { Reveal, SplitHeading } from "../components/motion/Reveal";
import { BoundaryPlan } from "../components/landing/BoundaryPlan";
import { gsap, useGSAP, MOTION } from "../lib/motion";

const STACK = [
  { layer: "Interface", tech: "React · Vite · Barba · GSAP" },
  { layer: "Coordination", tech: "Fastify · Pi · Socket.IO" },
  { layer: "Evidence", tech: "Postgres journal · Neo4j graph" },
  { layer: "Execution", tech: "Policy gate · Docker sandbox" },
];

const PIPE = [
  { name: "Input", detail: "trust labels" },
  { name: "Handoff", detail: "artifact broker" },
  { name: "Gate", detail: "authorize first" },
  { name: "Action", detail: "audited at the target" },
];

export function Architecture() {
  const scope = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION, () => {
        gsap.from(".stack__row", { autoAlpha: 0, x: -30, stagger: 0.1, delay: 0.4 });
        const tl = gsap.timeline({ scrollTrigger: { trigger: ".pipe", start: "top 75%", once: true } });
        tl.from(".pipe__stage", { autoAlpha: 0, y: 30, stagger: 0.15 }).from(
          ".pipe__link",
          { scaleX: 0, transformOrigin: "left center", stagger: 0.15, duration: 0.5, ease: "power2.out" },
          0.2,
        );
      });
      return () => mm.revert();
    },
    { scope },
  );
  return (
    <>
      <Header active="architecture" />
      <main ref={scope} id="main" tabIndex={-1} className="rampart architecture">
        <section className="arch-intro">
          <span className="eyebrow">Bastion / architecture</span>
          <SplitHeading as="h1" className="display display--xl">
            Agents reason. <em>Code authorizes.</em>
          </SplitHeading>
          <div className="stack">
            {STACK.map((s) => (
              <div className="stack__row" key={s.layer}>
                <span>{s.layer}</span>
                <strong>{s.tech}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="arch-pipe">
          <span className="eyebrow">The path of every action</span>
          <div className="pipe">
            {PIPE.map((p, i) => (
              <div className="pipe__cell" key={p.name}>
                <div className={`pipe__stage ${p.name === "Gate" ? "pipe__stage--gate" : ""}`}>
                  <span className="pipe__name">{p.name}</span>
                  <span className="pipe__detail">{p.detail}</span>
                </div>
                {i < PIPE.length - 1 ? <i className="pipe__link" aria-hidden="true" /> : null}
              </div>
            ))}
          </div>
          <Reveal>
            <p className="scope-note">
              Policy enforcement covers mediated tools. Prompt-injection detection is best effort; the gate does not depend on it.
            </p>
          </Reveal>
        </section>
        <section className="boundary-section">
          <BoundaryPlan />
          <a className="btn" href="/dashboard">
            Open console <span aria-hidden="true">↗</span>
          </a>
        </section>
      </main>
      <Footer />
    </>
  );
}
