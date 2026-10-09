import { useRef } from "react";
import { gsap, useGSAP, MOTION } from "./motion";

/**
 * Entrance for working surfaces (console, arena): headings, metrics and panels rise in sequence.
 * Elements rendered later (after data loads) are not re-animated, so live updates never flicker.
 */
export function usePageIntro<T extends HTMLElement>(selector: string) {
  const ref = useRef<T>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION, () => {
        const targets = gsap.utils.toArray<HTMLElement>(selector, ref.current);
        if (targets.length) gsap.from(targets, { y: 28, autoAlpha: 0, duration: 0.8, stagger: 0.07, delay: 0.1 });
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  return ref;
}
