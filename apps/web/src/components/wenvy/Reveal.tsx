import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

const EASE = [0.16, 1, 0.3, 1] as const;

/** Fade + rise as the element scrolls into view. */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 26,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  as?: "div" | "section" | "article" | "li";
}) {
  const reduced = useReducedMotion();
  const M = motion[as] as typeof motion.div;
  return (
    <M
      className={className}
      initial={reduced ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: reduced ? 0 : 0.7, ease: EASE, delay }}
    >
      {children}
    </M>
  );
}
