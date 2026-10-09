import { useState } from "react";
import VectorWordmark from "../components/originkit/ui/vector-wordmark";
import MouseEffects from "../components/originkit/ui/clickeffects";
import {
  Arrow,
  Footer,
  Header,
  Mark,
  useReducedMotion,
} from "../components/ui";
export function Landing() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState<"trace" | "contain" | "recover">("trace");
  return (
    <>
      <Header />
      <main id="main" tabIndex={-1}>
        <section className="hero container">
          <div className="hero-copy">
            <a className="announcement" href="/arena">
              <span className="tiny-mark">◇</span> The agent security arena is
              open <Arrow />
            </a>
            <h1>
              Stop the breach.
              <br />
              <em>
                Save the
                <br className="desktop-break" /> workflow.
              </em>
            </h1>
            <p>
              Your agents work together.
              <br />
              Their security should, too.
            </p>
            <div className="hero-actions">
              <a href="/dashboard" className="button">
                Open developer console <Arrow />
              </a>
              <a href="/arena" className="text-link">
                Enter the arena <Arrow diagonal />
              </a>
            </div>
            <span className="hero-note mono">TRACE. CONTAIN. RECOVER.</span>
          </div>
          <div className="hero-object" aria-label="Sculptural Bastion fortress">
            <div className="object-frame">
              <span className="corner c1" />
              <span className="corner c2" />
              <span className="corner c3" />
              <span className="corner c4" />
              <div className="monolith">
                <div className="monolith-top" />
                <div className="monolith-front">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="monolith-side">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="orbital orbital-one" />
              <div className="orbital orbital-two" />
              <span className="object-axis axis-left">Y</span>
              <span className="object-axis axis-bottom">X</span>
            </div>
            <div className="object-caption mono">
              <span>BASTION / CONTROL BOUNDARY</span>
              <span>↗</span>
            </div>
          </div>
        </section>
        <div className="principle-strip container">
          <span className="mono">BUILT AROUND YOUR AGENTS</span>
          <span>Scoped permissions</span>
          <span>Recorded provenance</span>
          <span>Selective recovery</span>
          <Mark />
        </div>
        <section className="security-section container" id="security">
          <div className="section-heading">
            <div>
              <span className="eyebrow">SECURITY AT EVERY HANDOFF</span>
              <h2>
                One bad input.
                <br />
                <em>Not a lost workflow.</em>
              </h2>
            </div>
            <p>
              A poisoned document can travel further than you think. Bastion
              puts controls between what an agent reads, shares, and executes.
            </p>
          </div>
          <div
            className="process-tabs"
            role="tablist"
            aria-label="Security process"
          >
            <button
              role="tab"
              id="tab-trace"
              aria-controls="process-panel"
              aria-selected={step === "trace"}
              onClick={() => setStep("trace")}
            >
              <span className="mono">01 /</span> Trace <Arrow />
            </button>
            <button
              role="tab"
              id="tab-contain"
              aria-controls="process-panel"
              aria-selected={step === "contain"}
              onClick={() => setStep("contain")}
            >
              <span className="mono">02 /</span> Contain <Arrow />
            </button>
            <button
              role="tab"
              id="tab-recover"
              aria-controls="process-panel"
              aria-selected={step === "recover"}
              onClick={() => setStep("recover")}
            >
              <span className="mono">03 /</span> Recover <Arrow />
            </button>
          </div>
          <div
            id="process-panel"
            role="tabpanel"
            aria-labelledby={`tab-${step}`}
            className="process-panel"
          >
            <div className="process-visual" aria-hidden="true">
              <div className={`boundary-diagram ${step}`}>
                <span className="diagram-source">Untrusted input</span>
                <span className="diagram-line" />
                <div className="diagram-gate">
                  <Mark />
                  <span>BASTION</span>
                </div>
                <span className="diagram-line" />
                <span className="diagram-output">
                  {step === "trace"
                    ? "Recorded dependency"
                    : step === "contain"
                      ? "Action boundary"
                      : "Trusted replacement"}
                </span>
                <div className="diagram-caption mono">
                  {step === "trace"
                    ? "OBSERVE THE HANDOFF"
                    : step === "contain"
                      ? "AUTHORIZE BEFORE EXECUTION"
                      : "RERUN AFFECTED TASKS"}
                </div>
              </div>
            </div>
            <div className="process-description">
              <span className="eyebrow">{step.toUpperCase()}</span>
              <h3>
                {step === "trace"
                  ? "Follow the evidence."
                  : step === "contain"
                    ? "Stop it at the boundary."
                    : "Keep the good work."}
              </h3>
              <p>
                {step === "trace"
                  ? "Connect source versions, agent tasks, artifacts, and tool calls in an inspectable knowledge graph. See the dependencies your workflow actually recorded."
                  : step === "contain"
                    ? "Check mediated tool calls against scoped permissions before execution. Quarantine suspicious sources and pause their dependent tasks."
                    : "Review the impact, approve a recovery plan, and rerun affected repeatable tasks using trusted inputs. Preserve unaffected validated outputs."}
              </p>
              <a href="/architecture" className="text-link">
                Explore the architecture <Arrow />
              </a>
            </div>
          </div>
        </section>
        <section className="arena-teaser container">
          <div>
            <span className="eyebrow">THE BASTION ARENA</span>
            <h2>
              Attack the input.
              <br />
              <em>Defend the outcome.</em>
            </h2>
            <p>
              A shared, sandboxed agent workflow. Private roles. Real security
              decisions. Join from your phone and put the boundaries to the
              test.
            </p>
            <a href="/arena" className="button">
              Enter the arena <Arrow diagonal />
            </a>
          </div>
          <div className="arena-teaser-art" aria-hidden="true">
            <div className="target-ring">
              <Mark />
              <span className="target-cross top" />
              <span className="target-cross bottom" />
              <span className="target-cross left" />
              <span className="target-cross right" />
            </div>
            <span className="mono">ATTACK / INVESTIGATE / RECOVER</span>
          </div>
        </section>
        <section className="closing container">
          <span className="eyebrow">BUILD WITH CONFIDENCE</span>
          <h2>
            Give your agents freedom.
            <br />
            <em>Give their actions boundaries.</em>
          </h2>
          <a href="/dashboard" className="button">
            Open your workspace <Arrow />
          </a>
        </section>
        <div className="wordmark-section" aria-hidden="true">
          {reduced ? (
            <div className="static-wordmark">BASTION</div>
          ) : (
            <VectorWordmark
              text="BASTION"
              textColor="#ffffff"
              shade="#464a4d"
              accent="#9281f7"
              font={{
                fontFamily: "Inter, sans-serif",
                fontWeight: 600,
                fontSize: 245,
                letterSpacing: "-0.045em",
              }}
              handles={{ labels: false, size: 30, spread: 22 }}
              style={{
                minWidth: 0,
                minHeight: 0,
                height: "100%",
                width: "100%",
              }}
            />
          )}
        </div>
      </main>
      <Footer />
      {!reduced && (
        <div className="click-effects" aria-hidden="true">
          <MouseEffects
            interactionMode="rings"
            color="#a1a4a5"
            effectSize={32}
            duration={0.3}
            strokeWidth={1}
            showLabel={false}
          />
        </div>
      )}
    </>
  );
}
