import { useRef, type ReactNode, type RefObject } from "react";
import { gsap, useGSAP, MOTION, SplitText } from "../../lib/motion";

/** Rise-in on scroll. Static (fully visible) for reduced motion. */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 48,
  as: Tag = "div",
  stagger,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  as?: "div" | "section" | "article" | "li" | "ul" | "ol";
  /** Animate direct children in sequence instead of the wrapper. */
  stagger?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION, () => {
        const el = ref.current!;
        const targets = stagger ? Array.from(el.children) : el;
        gsap.from(targets, {
          y,
          autoAlpha: 0,
          duration: 1,
          delay,
          stagger: stagger ?? 0,
          scrollTrigger: { trigger: el, start: "top 86%", once: true },
        });
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  const Any = Tag as "div";
  return (
    <Any ref={ref as RefObject<HTMLDivElement>} className={className}>
      {children}
    </Any>
  );
}

/** Heading whose lines slide up from behind a mask when scrolled into view. */
export function SplitHeading({
  children,
  className,
  as: Tag = "h2",
  id,
}: {
  children: ReactNode;
  className?: string;
  as?: "h1" | "h2" | "h3";
  id?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION, () => {
        const revert = splitLines(ref.current!);
        return revert;
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  return (
    <Tag ref={ref} className={className} id={id}>
      {children}
    </Tag>
  );
}

function splitLines(el: HTMLElement) {
  const split = SplitText.create(el, {
    type: "lines",
    mask: "lines",
    autoSplit: true,
    onSplit(self) {
      return gsap.from(self.lines, {
        yPercent: 110,
        duration: 1.1,
        stagger: 0.09,
        scrollTrigger: { trigger: el, start: "top 85%", once: true },
      });
    },
  });
  return () => split.revert();
}
