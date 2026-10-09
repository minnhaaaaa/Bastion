import { Header, Footer } from "../components/ui";
import { Reveal } from "../components/wenvy/Reveal";
import { Envelope } from "../components/wenvy/Envelope";
export function Architecture() {
  return (
    <>
      <Header active="architecture" />
      <main id="main" tabIndex={-1} className="architecture wenvy-site">
        <section className="band band--paper architecture-intro">
          <span className="numeral">BASTION / ARCHITECTURE</span>
          <h1 className="huge huge--ink">
            Agents reason.
            <br />
            Code <span className="u">authorizes.</span>
          </h1>
          <div className="model">
            <div className="architecture-stack">
              <div>
                <span>Interface</span>
                <strong>React · Vite · Barba</strong>
              </div>
              <div>
                <span>Coordination</span>
                <strong>Fastify · Pi · Socket.IO</strong>
              </div>
              <div>
                <span>Evidence</span>
                <strong>Postgres · Neo4j</strong>
              </div>
              <div>
                <span>Execution</span>
                <strong>Policy gate · Docker</strong>
              </div>
            </div>
            <Reveal>
              <Envelope />
            </Reveal>
          </div>
        </section>
        <section className="band band--ink">
          <div className="pipe">
            <div className="pipe__stage">
              <span className="pipe__name">Input</span>
              <span className="pipe__class">trust labels</span>
            </div>
            <span className="pipe__arrow" aria-hidden="true">
              →
            </span>
            <div className="pipe__stage">
              <span className="pipe__name">Handoff</span>
              <span className="pipe__class">artifact broker</span>
            </div>
            <span className="pipe__arrow" aria-hidden="true">
              →
            </span>
            <div className="pipe__stage pipe__stage--prod">
              <span className="pipe__name">Action</span>
              <span className="pipe__class">authorize first</span>
            </div>
          </div>
          <p className="scope-note">
            Policy enforcement covers mediated tools. Injection detection is
            best effort.
          </p>
          <a className="btn btn--invert" href="/dashboard">
            open console ↗
          </a>
        </section>
      </main>
      <Footer />
    </>
  );
}
