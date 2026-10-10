import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, useSpring, useTransform, type SpringOptions } from "framer-motion";
import { cn } from "@/lib/utils";

export function Spotlight({ className, size = 248, springOptions = { bounce: 0 } }: { className?: string; size?: number; springOptions?: SpringOptions }) {
  const ref = useRef<HTMLDivElement>(null), reduced = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const x = useSpring(0, springOptions), y = useSpring(0, springOptions);
  const left = useTransform(x, value => value - size / 2), top = useTransform(y, value => value - size / 2);
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent || reduced) return;
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const bounds = parent.getBoundingClientRect();
      x.set(event.clientX - bounds.left); y.set(event.clientY - bounds.top); setHovered(true);
    };
    const leave = () => setHovered(false);
    parent.addEventListener("pointermove", move); parent.addEventListener("pointerleave", leave); parent.addEventListener("pointercancel", leave);
    return () => { parent.removeEventListener("pointermove", move); parent.removeEventListener("pointerleave", leave); parent.removeEventListener("pointercancel", leave); };
  }, [reduced, x, y]);
  return <motion.div aria-hidden="true" ref={ref} className={cn("threat-spotlight", className)} style={{ width: size, height: size, left, top, opacity: hovered && !reduced ? 1 : 0 }} />;
}
