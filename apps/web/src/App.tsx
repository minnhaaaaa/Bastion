import { RunEvent, replay, toGraphView } from "@splitbrain/contracts";
import fixture from "@splitbrain/contracts/fixtures/demo-run.events.json";

// Placeholder (Member 1 replaces this). Proves the shared contracts + fixture load in the browser.
const events = (fixture as unknown[]).map((e) => RunEvent.parse(e));
const snapshot = replay(events);
const graph = toGraphView(snapshot);

export function App() {
  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <h1 className="text-3xl font-bold">SPLITBRAIN</h1>
      <p className="mt-2 text-neutral-400">Stop the breach. Save the workflow.</p>
      <dl className="mt-6 grid max-w-md grid-cols-2 gap-2 text-sm">
        <dt className="text-neutral-400">Fixture events</dt>
        <dd>{events.length}</dd>
        <dt className="text-neutral-400">Final run status</dt>
        <dd>{snapshot.run.status}</dd>
        <dt className="text-neutral-400">Graph</dt>
        <dd>
          {graph.nodes.length} nodes / {graph.edges.length} edges
        </dd>
      </dl>
    </main>
  );
}
