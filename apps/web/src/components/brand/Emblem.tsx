/**
 * Bastion emblem: a five-pointed star fort (trace italienne) with an inner keep.
 * Geometry is computed, single colour via currentColor; paths carry classes for DrawSVG.
 */
const star = (cx: number, cy: number, outer: number, inner: number, points = 5, rot = -90) =>
  Array.from({ length: points * 2 }, (_, i) => {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((rot + (i * 180) / points) * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(" ");

export function Emblem({ className = "", title }: { className?: string; title?: string }) {
  return (
    <svg className={`emblem ${className}`} viewBox="0 0 120 120" fill="none" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <polygon className="emblem__wall" points={star(60, 60, 56, 34)} stroke="currentColor" strokeWidth="5" strokeLinejoin="miter" />
      <polygon className="emblem__ravelin" points={star(60, 60, 38, 24)} stroke="currentColor" strokeWidth="2.5" opacity="0.7" />
      <rect className="emblem__keep" x="49" y="49" width="22" height="22" fill="currentColor" />
    </svg>
  );
}

/** Larger blueprint version used as a hero backdrop: walls, glacis ring and sight lines. */
export function FortPlan({ className = "" }: { className?: string }) {
  return (
    <svg className={`fort-plan ${className}`} viewBox="0 0 600 600" fill="none" aria-hidden="true">
      <circle className="fort-plan__glacis" cx="300" cy="300" r="286" stroke="currentColor" strokeWidth="1" strokeDasharray="4 10" />
      <polygon className="fort-plan__line" points={star(300, 300, 262, 162)} stroke="currentColor" strokeWidth="3" />
      <polygon className="fort-plan__line" points={star(300, 300, 214, 134)} stroke="currentColor" strokeWidth="1.5" />
      <polygon className="fort-plan__line" points={star(300, 300, 150, 96, 5, -54)} stroke="currentColor" strokeWidth="1" />
      {Array.from({ length: 5 }, (_, i) => {
        const a = ((-90 + i * 72) * Math.PI) / 180;
        return (
          <line key={i} className="fort-plan__sight" x1="300" y1="300" x2={300 + 286 * Math.cos(a)} y2={300 + 286 * Math.sin(a)} stroke="currentColor" strokeWidth="1" />
        );
      })}
      <rect className="fort-plan__keep" x="268" y="268" width="64" height="64" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}
