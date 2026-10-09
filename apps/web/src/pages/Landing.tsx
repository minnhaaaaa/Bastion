import { motion, useReducedMotion } from "framer-motion";
import { Reveal } from "../components/wenvy/Reveal";
import { Terminal } from "../components/wenvy/Terminal";
import { Header, Footer } from "../components/ui";

const threats = [
  { title: "Prompt injection", from: "Untrusted input", gate: "Policy gate", action: "Contain", symbol: "⊣" },
  { title: "Unsafe tool use", from: "Tool call", gate: "Permission check", action: "Authorize", symbol: "✓" },
  { title: "Compromised output", from: "Dependency", gate: "Selective rerun", action: "Recover", symbol: "↻" },
];
const steps = [
  { title: "Trace", detail: "Every recorded handoff.", symbol: "↗" },
  { title: "Contain", detail: "Before the action executes.", symbol: "⊣" },
  { title: "Recover", detail: "Only the affected work.", symbol: "↻" },
];

export function Landing() {
  const reduced = useReducedMotion();
  return (
    <>
      <Header />
      <main id="main" tabIndex={-1} className="wenvy-site bastion-home">
        <section className="intro" aria-labelledby="intro-title">
          <motion.div className="intro__copy" initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.65 }}>
            <span className="intro__label">An agent workspace. Security built in.</span>
            <h1 id="intro-title">Build freely.<br /><em>Act securely.</em></h1>
            <p>Stop the breach.<br />Save the workflow.</p>
            <div className="intro__actions">
              <a className="btn btn--solid" href="/dashboard">Open console <span aria-hidden="true">↗</span></a>
              <a className="intro__link" href="/arena">Enter arena <span aria-hidden="true">→</span></a>
            </div>
          </motion.div>
          <a className="intro__scroll" href="#security">Explore the boundaries <span aria-hidden="true">↓</span></a>
        </section>

        <section className="threats-section" id="security" aria-labelledby="threats-title">
          <Reveal className="home-section-head">
            <h2 id="threats-title">One bad input.<br /><em>Keep the rest.</em></h2>
            <a className="home-link" href="/architecture">The architecture <span aria-hidden="true">↗</span></a>
          </Reveal>
          <div className="threat-grid">
            {threats.map((threat, i) => <Reveal as="article" className="threat-tile" key={threat.title} delay={i * 0.06}>
              <div className="threat-tile__head"><span>{threat.action}</span><span aria-hidden="true">{threat.symbol}</span></div>
              <h3>{threat.title}</h3>
              <div className="threat-route"><span>{threat.from}</span><span aria-hidden="true">↓</span><strong>{threat.gate}</strong></div>
            </Reveal>)}
          </div>
        </section>

        <section className="journal-section" id="flow" aria-labelledby="journal-title">
          <div className="journal-section__intro">
            <Reveal><span className="home-label">The workflow stays yours</span><h2 id="journal-title">Follow every<br /><em>handoff.</em></h2></Reveal>
            <Reveal className="journal-links">
              <a href="/dashboard">Provenance graph <span aria-hidden="true">↗</span></a>
              <a href="/dashboard">Tool decisions <span aria-hidden="true">↗</span></a>
              <a href="/dashboard">Recovery plans <span aria-hidden="true">↗</span></a>
            </Reveal>
          </div>
          <Reveal className="journal-section__terminal" delay={0.1}><Terminal /></Reveal>
          <div className="home-steps">
            {steps.map(step => <Reveal className="home-step" key={step.title}><span aria-hidden="true">{step.symbol}</span><div><h3>{step.title}</h3><p>{step.detail}</p></div></Reveal>)}
          </div>
        </section>

        <section className="arena-invite" aria-labelledby="arena-invite-title">
          <Reveal><span className="home-label">Bastion / Arena</span><h2 id="arena-invite-title">Your move.</h2><p>Attack the input. Defend the outcome.</p></Reveal>
          <a className="btn btn--solid" href="/arena">Enter the arena <span aria-hidden="true">↗</span></a>
        </section>
      </main>
      <Footer />
    </>
  );
}
