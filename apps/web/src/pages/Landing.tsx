import { MagneticCursor } from "../components/ui/magnetic-cursor";
import { Reveal } from "../components/wenvy/Reveal";
import { Terminal } from "../components/wenvy/Terminal";
import { Header, Footer } from "../components/ui";

import { Tilt } from "../components/ui/tilt";
import { Spotlight } from "../components/ui/spotlight";
import { ParallaxComponent } from "../components/ui/parallax-scrolling";

const threats = [
  { title: "Prompt injection", from: "Untrusted input", gate: "Policy gate", action: "Contain" },
  { title: "Unsafe tool use", from: "Tool call", gate: "Permission check", action: "Authorize" },
  { title: "Compromised output", from: "Dependency", gate: "Selective rerun", action: "Recover" },
];
const steps = [
  { title: "Trace", detail: "Every recorded handoff." },
  { title: "Contain", detail: "Before the action executes." },
  { title: "Recover", detail: "Only the affected work." },
];

export function Landing() {
  return (
    <MagneticCursor>
      <Header />
      <ParallaxComponent><main id="main" tabIndex={-1} className="wenvy-site bastion-home">
        <section className="intro" data-parallax-layers aria-labelledby="intro-title">
          <div className="intro__copy">
            <span className="intro__label">An agent workspace. Security built in.</span>
            <div data-parallax-layer="24"><h1 id="intro-title">Build freely.<br /><em>Act securely.</em></h1></div>
            <p>Stop the breach.<br />Save the workflow.</p>
            <div className="intro__actions">
              <a className="btn btn--solid" href="/dashboard">Open console <span aria-hidden="true">↗</span></a>
              <a className="intro__link" href="/arena">Enter arena <span aria-hidden="true">→</span></a>
            </div>
          </div>
          <a className="intro__scroll" href="#security">Explore the boundaries <span aria-hidden="true">↓</span></a>
        </section>

        <section className="threats-section" id="security" aria-labelledby="threats-title">
          <Reveal className="home-section-head">
            <h2 id="threats-title">One bad input.<br /><em>Keep the rest.</em></h2>
            <a className="home-link" href="/architecture">The architecture <span aria-hidden="true">↗</span></a>
          </Reveal>
          <div className="threat-grid" data-parallax-layers>
            {threats.map((threat, i) => <div className="threat-card-depth" data-parallax-layer={i === 1 ? "-18" : "12"} key={threat.title}>
              <Tilt className="threat-tilt" rotationFactor={6} isRevese springOptions={{ stiffness: 180, damping: 24 }}>
                <article className="threat-tile">
                  <Spotlight />
                  <div className="threat-tile__head"><span>{threat.action}</span></div>
                  <h3>{threat.title}</h3>
                  <div className="threat-route"><span>{threat.from}</span><strong>{threat.gate}</strong></div>
                </article>
              </Tilt>
            </div>)}
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
            {steps.map(step => <Reveal className="home-step" key={step.title}><div><h3>{step.title}</h3><p>{step.detail}</p></div></Reveal>)}
          </div>
        </section>

        <section className="arena-invite" data-parallax-layers aria-labelledby="arena-invite-title">
          <Reveal><div data-parallax-layer="18"><span className="home-label">Bastion / Arena</span><h2 id="arena-invite-title">Your move.</h2><p>Attack the input. Defend the outcome.</p></div></Reveal>
          <a className="btn btn--solid" href="/arena">Enter the arena <span aria-hidden="true">↗</span></a>
        </section>
      </main></ParallaxComponent>
      <Footer />
    </MagneticCursor>
  );
}
