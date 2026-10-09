import { useRef } from "react";
import { gsap, useGSAP, MOTION } from "../../lib/motion";
import { Emblem } from "./Emblem";

/** Arena warm-up visual: the fort emblem under a rotating sentry sweep. Purely decorative. */
export function Watchtower() {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION, () => {
        gsap.from(".emblem__wall, .emblem__ravelin", { drawSVG: 0, duration: 1.6, stagger: 0.25, ease: "power2.inOut" });
        gsap.from(".emblem__keep", { scale: 0, transformOrigin: "50% 50%", delay: 1, ease: "back.out(2)" });
        gsap.to(".watchtower__sweep", { rotation: 360, duration: 6, repeat: -1, ease: "none", svgOrigin: "150 150" });
        gsap.to(".watchtower__ping", { scale: 2.4, autoAlpha: 0, duration: 2.4, repeat: -1, stagger: 0.8, ease: "power1.out", svgOrigin: "150 150" });
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  return (
    <div ref={ref} className="watchtower" aria-hidden="true">
      <svg viewBox="0 0 300 300">
        <defs>
          <linearGradient id="sweep" x1="0" x2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.55" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx="150" cy="150" r="140" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeDasharray="3 9" />
        <circle className="watchtower__ping" cx="150" cy="150" r="56" fill="none" stroke="currentColor" strokeOpacity="0.5" />
        <circle className="watchtower__ping" cx="150" cy="150" r="56" fill="none" stroke="currentColor" strokeOpacity="0.5" />
        <path className="watchtower__sweep" d="M150 150 L290 150 A140 140 0 0 0 249 51 Z" fill="url(#sweep)" />
        <foreignObject x="80" y="80" width="140" height="140">
          <Emblem className="watchtower__emblem" />
        </foreignObject>
      </svg>
    </div>
  );
}
