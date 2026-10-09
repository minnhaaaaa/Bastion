import { motion, useReducedMotion } from "framer-motion";
import { Koi } from "../components/wenvy/Koi";
import { Reveal } from "../components/wenvy/Reveal";
import { Envelope } from "../components/wenvy/Envelope";
import { Terminal } from "../components/wenvy/Terminal";
import { Header, Footer } from "../components/ui";
const ease = [0.16, 1, 0.3, 1] as const;
export function Landing() {
  const reduced = useReducedMotion();
  return (
    <>
      <Header />
      <main id="main" tabIndex={-1} className="wenvy-site">
        <section className="hero" aria-labelledby="wordmark">
          <Koi className="koi koi--br" />
          <motion.div
            className="hero__inner"
            initial={reduced ? false : { opacity: 0, y: 22 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0 : 0.8, ease }}
          >
            <h1 className="wordmark" id="wordmark" aria-label="Bastion">
              <span className="wordmark__line" data-text="BAS">
                BAS
              </span>
              <span className="wordmark__line" data-text="TION">
                TION
              </span>
            </h1>
            <p className="hero__hand">stop the breach. save the workflow.</p>
            <div className="hero__lede">
              <p>
                An agent workspace.
                <br />
                <strong>Security built in.</strong>
              </p>
            </div>
            <div className="hero__actions">
              <a className="btn btn--solid" href="/dashboard">
                open console <span aria-hidden="true">↗</span>
              </a>
              <a className="btn btn--ghost" href="/arena">
                enter arena <span aria-hidden="true">→</span>
              </a>
            </div>
          </motion.div>
        </section>
        <section className="band band--ink" id="security">
          <Reveal className="band__head">
            <span className="numeral">01</span>
            <h2 className="huge">
              One bad input.
              <br />
              <span className="u">Not a lost workflow.</span>
            </h2>
          </Reveal>
          <div className="ledger">
            <Reveal className="ledger__row">
              <span className="ledger__n">i.</span>
              <h3>Prompt injection</h3>
              <div className="threat-path">
                <span>input</span>
                <span aria-hidden="true">→</span>
                <span className="threat-stop">policy gate ⊣</span>
              </div>
              <span className="ledger__tag">contain</span>
            </Reveal>
            <Reveal className="ledger__row" delay={0.06}>
              <span className="ledger__n">ii.</span>
              <h3>Unsafe tool use</h3>
              <div className="threat-path">
                <span>tool call</span>
                <span aria-hidden="true">→</span>
                <span className="threat-stop">permission check ⊣</span>
              </div>
              <span className="ledger__tag">authorize</span>
            </Reveal>
            <Reveal className="ledger__row" delay={0.12}>
              <span className="ledger__n">iii.</span>
              <h3>Compromised outputs</h3>
              <div className="threat-path">
                <span>dependency</span>
                <span aria-hidden="true">→</span>
                <span className="threat-stop">selective rerun ↻</span>
              </div>
              <span className="ledger__tag">recover</span>
            </Reveal>
          </div>
        </section>
        <section className="band band--paper" id="model">
          <Reveal className="band__head">
            <span className="numeral">02</span>
            <h2 className="huge huge--ink">
              Freedom to reason.
              <br />
              Boundaries to act.
            </h2>
          </Reveal>
          <div className="model">
            <Reveal>
              <ol className="security-steps">
                <li>
                  <span>01</span>
                  <div>
                    <h3>Trace.</h3>
                    <p>Every recorded handoff.</p>
                  </div>
                  <span aria-hidden="true">↗</span>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <h3>Contain.</h3>
                    <p>Before the action executes.</p>
                  </div>
                  <span aria-hidden="true">⊣</span>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <h3>Recover.</h3>
                    <p>Only the affected work.</p>
                  </div>
                  <span aria-hidden="true">↻</span>
                </li>
              </ol>
              <a href="/architecture" className="btn btn--ghost">
                under the hood ↗
              </a>
            </Reveal>
            <Reveal delay={0.1}>
              <Envelope />
            </Reveal>
          </div>
        </section>
        <section className="band band--ink" id="flow">
          <Reveal className="band__head">
            <span className="numeral">03</span>
            <h2 className="huge">
              Nothing hidden.
              <br />
              Everything <span className="u">traceable.</span>
            </h2>
          </Reveal>
          <div className="flow">
            <Reveal>
              <Terminal />
            </Reveal>
            <Reveal className="flow__side" delay={0.1}>
              <div className="workflow-glyph" aria-hidden="true">
                <span>◇</span>
                <i />
                <span>◈</span>
                <i />
                <span>▣</span>
              </div>
              <div className="workflow-links">
                <a href="/dashboard">
                  provenance graph <span>↗</span>
                </a>
                <a href="/dashboard">
                  tool decisions <span>↗</span>
                </a>
                <a href="/dashboard">
                  recovery plans <span>↗</span>
                </a>
              </div>
            </Reveal>
          </div>
        </section>
        <section className="closer">
          <Koi className="koi koi--closer" />
          <h2 className="closer__line">YOUR MOVE.</h2>
          <p className="closer__sub">attack the input. defend the outcome.</p>
          <a href="/arena" className="btn btn--invert">
            enter the arena <span aria-hidden="true">→</span>
          </a>
        </section>
      </main>
      <Footer />
    </>
  );
}
