import { Header, Footer, Arrow } from "../components/ui";
export function Architecture() {
  return (
    <>
      <Header active="architecture" />
      <main id="main" tabIndex={-1} className="container architecture">
        <span className="eyebrow">UNDER THE HOOD</span>
        <h1>
          Security is
          <br />
          <em>a boundary.</em>
        </h1>
        <p className="lead">
          Agents reason. Application code authorizes. Bastion coordinates the
          handoffs and keeps a record of what happened.
        </p>
        <div className="architecture-flow">
          <span>Agent runtime</span>
          <Arrow />
          <span>Artifact broker</span>
          <Arrow />
          <span>Policy gate</span>
          <Arrow />
          <span>Controlled tools</span>
        </div>
        <div className="architecture-grid">
          <article>
            <span className="eyebrow">INTERFACE</span>
            <h2>React + Vite</h2>
            <p>
              TypeScript components, React Query for backend state, React Flow
              for provenance, and Barba for page transitions.
            </p>
          </article>
          <article>
            <span className="eyebrow">COORDINATION</span>
            <h2>Fastify + Pi</h2>
            <p>
              A TypeScript DAG orchestrator delegates tasks to isolated Pi
              sessions. Socket.IO delivers persisted events to the console.
            </p>
          </article>
          <article>
            <span className="eyebrow">EVIDENCE</span>
            <h2>Postgres + Neo4j</h2>
            <p>
              Postgres holds authoritative records. Neo4j projects source, task,
              artifact, and tool dependencies for investigation.
            </p>
          </article>
          <article>
            <span className="eyebrow">EXECUTION</span>
            <h2>Policy + Docker</h2>
            <p>
              Scoped capabilities and deterministic checks gate supported tool
              calls. Isolated workers provide a separate sandbox boundary.
            </p>
          </article>
        </div>
        <div className="boundary-note">
          <span className="eyebrow">THE SECURITY CLAIM</span>
          <p>
            Specified policies at controlled execution boundaries. Traceable
            observed dependencies. Detection is best effort; coverage depends on
            the tools and channels Bastion mediates.
          </p>
        </div>
        <a className="button" href="/dashboard">
          Explore the console <Arrow />
        </a>
      </main>
      <Footer />
    </>
  );
}
