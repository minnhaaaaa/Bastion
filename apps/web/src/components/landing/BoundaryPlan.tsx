import { useRef } from "react";
import { gsap, useGSAP, MOTION } from "../../lib/motion";

const LAYERS = [
  { label: "Source input", note: "trust labels on every document" },
  { label: "Artifact handoff", note: "brokered, versioned, observed" },
  { label: "Policy gate", note: "authorize before execution" },
  { label: "Tool action", note: "sandboxed, audited at the target" },
];

/** Concentric fortress walls: each enforcement layer draws in as the section scrolls. */
export function BoundaryPlan() {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION, () => {
        const tl = gsap.timeline({
          scrollTrigger: { trigger: ref.current, start: "top 70%", end: "bottom 60%", scrub: 0.8 },
        });
        gsap.utils.toArray<SVGPathElement>(".boundary__wall", ref.current).forEach((wall, i) => {
          tl.from(wall, { drawSVG: "50% 50%", duration: 1 }, i * 0.8);
          tl.from(`.boundary__layer:nth-child(${i + 1})`, { autoAlpha: 0.15, x: -20, duration: 0.6 }, i * 0.8 + 0.3);
        });
        tl.from(".boundary__core", { scale: 0, transformOrigin: "50% 50%", duration: 0.6, ease: "back.out(2)" });
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  // Four nested notched squares, rotated 45° so they read as bastion walls.
  const walls = [150, 112, 76, 42];
  return (
    <div ref={ref} className="boundary">
      <svg className="boundary__plan" viewBox="0 0 340 340" role="img" aria-label="Four nested enforcement boundaries around a tool action">
        {walls.map((r, i) => {
          const n = r * 0.22;
          const d = `M ${170 - r + n} ${170 - r} H ${170 + r} V ${170 + r - n} L ${170 + r - n} ${170 + r} H ${170 - r} V ${170 - r + n} Z`;
          return <path key={r} className={`boundary__wall boundary__wall--${i}`} d={d} />;
        })}
        <rect className="boundary__core" x="158" y="158" width="24" height="24" />
      </svg>
      <ol className="boundary__layers">
        {LAYERS.map((l, i) => (
          <li key={l.label} className="boundary__layer">
            <span className="boundary__index">{String(i + 1).padStart(2, "0")}</span>
            <strong>{l.label}</strong>
            <span>{l.note}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
