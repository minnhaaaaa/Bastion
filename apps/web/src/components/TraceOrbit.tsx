// Adapted from NetworkOrbit.tsx in minnhaaaaa/Blockchain-Simulation, commit
// a1c6bbf8874176047b0e52d350de11b2cd8bf497. MIT: apps/web/licenses/blockchain-simulation-MIT.txt.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { toGraphView, type RunSnapshot } from "@bastion/contracts";

export function TraceOrbit({ snapshot, onSelect }: { snapshot: RunSnapshot; onSelect?: (id: string) => void }) {
  const view = useMemo(() => toGraphView(snapshot), [snapshot]);
  const svg = useRef<SVGSVGElement>(null);
  const phase = useRef(0);
  const marker = useId().replaceAll(":", "");
  const [paused, setPaused] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<string>();
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const membership = view.nodes.map(node => node.id).join(",");
  const connections = view.edges.map(edge => `${edge.source}:${edge.target}`).join(",");
  useEffect(() => {
    const root = svg.current;
    if (!root) return;
    const nodes = [...root.querySelectorAll<SVGGElement>(".trace-orbit-node")];
    const edges = [...root.querySelectorAll<SVGLineElement>(".trace-orbit-edge")];
    let frame = 0, previous = 0;
    const draw = (time: number) => {
      if (!document.hidden && !paused && !reduced && !root.matches(":hover, :focus-within")) phase.current += previous ? Math.min(time - previous, 50) * .00008 : 0;
      previous = time;
      const points = new Map<string, { x: number; y: number }>();
      nodes.forEach((node, index) => {
        const ring = Math.floor(index / 12);
        const count = Math.min(12, nodes.length - ring * 12);
        const angle = phase.current + (index % 12) / count * Math.PI * 2 - Math.PI / 2;
        const radius = 130 + ring * 95;
        const x = 400 + radius * Math.cos(angle), y = 250 + radius * Math.sin(angle);
        node.setAttribute("transform", `translate(${x} ${y})`);
        points.set(node.dataset.id!, { x, y });
      });
      edges.forEach(edge => {
        const from = points.get(edge.dataset.source!), to = points.get(edge.dataset.target!);
        if (!from || !to) return;
        const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1;
        edge.setAttribute("x1", String(from.x + dx / length * 19)); edge.setAttribute("y1", String(from.y + dy / length * 19));
        edge.setAttribute("x2", String(to.x - dx / length * 23)); edge.setAttribute("y2", String(to.y - dy / length * 23));
      });
      if (!paused && !reduced && !document.hidden) frame = requestAnimationFrame(draw);
    };
    const start = () => { cancelAnimationFrame(frame); previous = 0; draw(performance.now()); };
    start(); document.addEventListener("visibilitychange", start);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", start); };
  }, [membership, connections, paused, reduced]);
  const inspected = view.nodes.find(node => node.id === selected);
  const rings = Math.max(1, Math.ceil(view.nodes.length / 12));
  const scale = zoom * Math.min(1, 205 / (130 + (rings - 1) * 95));
  return <div className="trace-orbit">
    <div className="trace-orbit-controls"><span>Hover to hold · select a node</span>
      <button type="button" className="desk-icon" aria-label={paused ? "Resume orbit" : "Pause orbit"} aria-pressed={paused} disabled={reduced} onClick={() => setPaused(value => !value)}>{paused ? <Play /> : <Pause />}</button>
      <button type="button" className="desk-icon" aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .2))}><ZoomOut /></button>
      <button type="button" className="desk-icon" aria-label="Zoom in" disabled={zoom >= 2.5} onClick={() => setZoom(value => Math.min(2.5, value + .2))}><ZoomIn /></button>
      <button type="button" className="desk-icon" aria-label="Reset graph view" onClick={() => { setZoom(1); setSelected(undefined); }}><RotateCcw /></button>
    </div>
    <svg ref={svg} viewBox="0 0 800 500" role="group" aria-label="Recorded provenance orbit">
      <defs><marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      <g transform={`translate(400 250) scale(${scale}) translate(-400 -250)`}>
        {Array.from({ length: rings }, (_, ring) => <circle key={ring} className="trace-orbit-track" cx="400" cy="250" r={130 + ring * 95} />)}
        {view.edges.map(edge => <line key={edge.id} data-source={edge.source} data-target={edge.target} className={`trace-orbit-edge ${inspected && (edge.source === inspected.id || edge.target === inspected.id) ? "is-highlighted" : ""}`} markerEnd={`url(#${marker})`}><title>{edge.relation}</title></line>)}
        {view.nodes.map(node => <g key={node.id} data-id={node.id} className={`trace-orbit-node ${selected === node.id ? "is-selected" : ""} ${node.label === "SecurityIncident" || node.decision === "DENY" || (node.securityState && node.securityState !== "CLEAR") ? "is-alert" : ""}`} role="button" tabIndex={0} aria-label={`Inspect ${node.title}`} aria-pressed={selected === node.id}
          onClick={() => { setSelected(node.id); onSelect?.(node.id); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(node.id); onSelect?.(node.id); } }}>
          <circle r="19" /><text y="4" className="trace-orbit-symbol">{node.label.slice(0, 1)}</text><text y="36">{node.title.length > 24 ? `${node.title.slice(0, 21)}…` : node.title}</text><title>{node.label}: {node.title} · {node.decision ?? node.securityState ?? node.taskState ?? "Recorded"}</title>
        </g>)}
      </g>
    </svg>
    {inspected && <div className="trace-orbit-inspection"><strong>{inspected.title}</strong><span>{inspected.label} · {inspected.decision ?? inspected.securityState ?? inspected.taskState ?? "Recorded"}</span><span>{view.edges.filter(edge => edge.source === inspected.id || edge.target === inspected.id).map(edge => edge.relation).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}</span></div>}
  </div>;
}
