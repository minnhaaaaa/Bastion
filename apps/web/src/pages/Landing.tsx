import { useRef } from "react";
import { Header, Footer } from "../components/ui";
import { FortPlan } from "../components/brand/Emblem";
import { Reveal, SplitHeading } from "../components/motion/Reveal";
import { BoundaryPlan } from "../components/landing/BoundaryPlan";
import { SignalLog } from "../components/landing/SignalLog";
import { gsap, useGSAP, SplitText, MOTION } from "../lib/motion";

const THREATS = [
  { n: "I", title: "Prompt injection", from: "Untrusted input", gate: "Policy gate", verb: "Contain" },
  { n: "II", title: "Unsafe tool use", from: "Tool call", gate: "Permission check", verb: "Authorize" },
  { n: "III", title: "Compromised output", from: "Dependent task", gate: "Selective rerun", verb: "Recover" },
];

const DOCTRINE = [
  { word: "Trace", line: "Every handoff between agents is brokered, versioned and recorded as provenance.", mark: "01" },
  { word: "Contain", line: "Tool calls are authorized before they run. A poisoned source is quarantined on the spot.", mark: "02" },
  { word: "Recover", line: "Only the work that touched the breach is rerun — verified, and approved by a human.", mark: "03" },
];

export function Landing() {
  const scope = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION, () => {
        // Hero: wordmark rises letter by letter, fort plan draws, tagline scrambles in.
        const title = SplitText.create(".hero__word", { type: "chars", mask: "chars", charsClass: "hero__char" });
        const intro = gsap.timeline({ delay: 0.25 });
        intro
          .from(title.chars, { yPercent: 115, stagger: 0.05, duration: 1.1 })
          .from(".hero__rampart", { scaleX: 0, duration: 1, ease: "power3.inOut" }, 0.5)
          .from(".hero .fort-plan__line, .hero .fort-plan__keep", { drawSVG: 0, duration: 2, stagger: 0.18, ease: "power2.inOut" }, 0.1)
          .from(".hero .fort-plan__sight", { drawSVG: "0% 0%", duration: 1.2, stagger: 0.06 }, 0.6)
          .to(".hero__tag", { duration: 1.4, scrambleText: { text: "{original}", chars: "BASTION01#/", speed: 0.6 } }, 0.7)
          .from(".hero__lede, .hero__actions > *", { y: 24, autoAlpha: 0, stagger: 0.08 }, 0.9)
          .from(".hero__meta > *", { autoAlpha: 0, x: -12, stagger: 0.08 }, 1.1);
        gsap.to(".hero .fort-plan", { rotation: 360, duration: 240, repeat: -1, ease: "none", transformOrigin: "50% 50%" });
        gsap.to(".hero .fort-plan", {
          yPercent: 18,
          ease: "none",
          scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
        });

        // Ticker loops forever.
        gsap.to(".ticker__track", { xPercent: -50, duration: 28, ease: "none", repeat: -1 });

        // Threats: each card rises; its gate slams shut across the path.
        gsap.utils.toArray<HTMLElement>(".threat").forEach((card) => {
          const tl = gsap.timeline({ scrollTrigger: { trigger: card, start: "top 82%", once: true } });
          tl.from(card, { y: 70, autoAlpha: 0, duration: 0.9 })
            .from(card.querySelector(".threat__path-line"), { scaleX: 0, transformOrigin: "left center", duration: 0.7, ease: "power2.out" }, "-=0.4")
            .from(card.querySelector(".threat__gate"), { scaleY: 0, transformOrigin: "top center", duration: 0.35, ease: "slam" })
            .from(card.querySelector(".threat__verb"), { autoAlpha: 0, x: 10, duration: 0.4 }, "<0.1");
        });

        // Doctrine: pinned horizontal sweep on wide screens.
        const track = document.querySelector<HTMLElement>(".doctrine__track");
        if (track && window.matchMedia("(min-width: 900px)").matches) {
          // The track's own box (not scrollWidth, which includes overflowing glyphs).
          const distance = () => Math.max(0, track.offsetWidth - document.documentElement.clientWidth);
          const sweep = gsap.to(track, {
            x: () => -distance(),
            ease: "none",
            scrollTrigger: {
              trigger: ".doctrine",
              start: "top top",
              end: () => `+=${distance()}`,
              pin: true,
              scrub: 0.6,
              invalidateOnRefresh: true,
            },
          });
          gsap.utils.toArray<HTMLElement>(".doctrine__panel").forEach((panel) => {
            gsap.from(panel.querySelector(".doctrine__word"), {
              xPercent: 30,
              autoAlpha: 0.2,
              scrollTrigger: { trigger: panel, containerAnimation: sweep, start: "left 85%", end: "left 35%", scrub: true },
            });
          });
        }

        // Closer: magnetic call to action.
        const cta = document.querySelector<HTMLElement>(".closer__cta");
        if (cta) {
          const xTo = gsap.quickTo(cta, "x", { duration: 0.5, ease: "power3" });
          const yTo = gsap.quickTo(cta, "y", { duration: 0.5, ease: "power3" });
          const move = (e: PointerEvent) => {
            const r = cta.getBoundingClientRect();
            xTo((e.clientX - (r.left + r.width / 2)) * 0.3);
            yTo((e.clientY - (r.top + r.height / 2)) * 0.3);
          };
          const reset = () => (xTo(0), yTo(0));
          cta.addEventListener("pointermove", move);
          cta.addEventListener("pointerleave", reset);
          return () => {
            cta.removeEventListener("pointermove", move);
            cta.removeEventListener("pointerleave", reset);
          };
        }
      });
      return () => mm.revert();
    },
    { scope },
  );

  return (
    <>
      <Header />
      <main ref={scope} id="main" tabIndex={-1} className="rampart">
        <section className="hero" aria-labelledby="hero-title">
          <FortPlan className="hero__plan" />
          <div className="hero__inner">
            <div className="hero__meta" aria-hidden="true">
              <span>Agent security</span>
              <span>Policy-gated execution</span>
              <span>Selective recovery</span>
            </div>
            <h1 className="hero__title" id="hero-title" aria-label="Bastion">
              <span className="hero__word" aria-hidden="true">
                BASTION
              </span>
              <span className="hero__rampart" aria-hidden="true" />
            </h1>
            <p className="hero__tag">Stop the breach. Save the workflow.</p>
            <p className="hero__lede">
              An agent workspace with security built into every handoff. Tool calls are authorized before they run, poisoned
              inputs are quarantined, and only the affected work is redone.
            </p>
            <div className="hero__actions">
              <a className="btn" href="/dashboard">
                Open console <span aria-hidden="true">↗</span>
              </a>
              <a className="btn btn--ghost" href="/arena">
                Enter the arena <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
          <div className="ticker" aria-hidden="true">
            <div className="ticker__track">
              {Array.from({ length: 2 }, (_, k) => (
                <span key={k}>
                  Trace <i>◆</i> Contain <i>◆</i> Recover <i>◆</i> Authorize before execution <i>◆</i> Quarantine the source{" "}
                  <i>◆</i> Rerun only what was touched <i>◆</i>{" "}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className="threats" id="threats" aria-labelledby="threats-title">
          <div className="section-head">
            <span className="section-head__n">01</span>
            <SplitHeading className="display" id="threats-title">
              One bad input. <em>Not a lost workflow.</em>
            </SplitHeading>
          </div>
          <div className="threat-grid">
            {THREATS.map((t) => (
              <article className="threat" key={t.n}>
                <span className="threat__n">{t.n}</span>
                <h3>{t.title}</h3>
                <div className="threat__path" aria-label={`${t.from} is stopped at the ${t.gate}`}>
                  <span>{t.from}</span>
                  <i className="threat__path-line" aria-hidden="true" />
                  <b className="threat__gate" aria-hidden="true" />
                  <span>{t.gate}</span>
                </div>
                <span className="threat__verb">{t.verb}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="doctrine" aria-label="Trace, contain, recover">
          <div className="doctrine__track">
            <div className="doctrine__intro">
              <span className="eyebrow">Doctrine</span>
              <h2 className="display">
                Freedom to reason. <em>Walls to act.</em>
              </h2>
              <p>Agents think freely. Every action they take crosses a wall that code — not the model — controls.</p>
            </div>
            {DOCTRINE.map((d) => (
              <article className="doctrine__panel" key={d.word}>
                <span className="doctrine__mark">{d.mark}</span>
                <h3 className="doctrine__word">{d.word}</h3>
                <p>{d.line}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="boundary-section" aria-labelledby="boundary-title">
          <div className="section-head">
            <span className="section-head__n">02</span>
            <SplitHeading className="display" id="boundary-title">
              Four walls between <em>a thought and an action.</em>
            </SplitHeading>
          </div>
          <BoundaryPlan />
          <a className="text-link" href="/architecture">
            Read the architecture <span aria-hidden="true">↗</span>
          </a>
        </section>

        <section className="ledger-section" aria-labelledby="ledger-title">
          <div className="section-head">
            <span className="section-head__n">03</span>
            <SplitHeading className="display" id="ledger-title">
              Nothing hidden. <em>Every step on the record.</em>
            </SplitHeading>
          </div>
          <div className="ledger-grid">
            <Reveal>
              <SignalLog />
            </Reveal>
            <Reveal className="ledger-links" stagger={0.08} as="ul">
              <li>
                <a href="/dashboard">
                  <span>Provenance graph</span> <i aria-hidden="true">↗</i>
                </a>
              </li>
              <li>
                <a href="/dashboard">
                  <span>Tool decisions</span> <i aria-hidden="true">↗</i>
                </a>
              </li>
              <li>
                <a href="/dashboard">
                  <span>Recovery plans</span> <i aria-hidden="true">↗</i>
                </a>
              </li>
            </Reveal>
          </div>
        </section>

        <section className="closer" aria-labelledby="closer-title">
          <SplitHeading className="closer__line" id="closer-title">
            Hold the line.
          </SplitHeading>
          <p className="closer__sub">One player attacks the input. Everyone else defends the outcome.</p>
          <a href="/arena" className="btn btn--bone closer__cta">
            Enter the arena <span aria-hidden="true">→</span>
          </a>
        </section>
      </main>
      <Footer />
    </>
  );
}
