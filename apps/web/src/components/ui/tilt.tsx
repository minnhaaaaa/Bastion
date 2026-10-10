import { useRef, type ReactNode, type PointerEvent } from "react";
import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionStyle, type SpringOptions } from "framer-motion";

export function Tilt({ children, className, style, rotationFactor = 8, isRevese = false, springOptions }: {
  children: ReactNode; className?: string; style?: MotionStyle; rotationFactor?: number; isRevese?: boolean; springOptions?: SpringOptions;
}) {
  const ref = useRef<HTMLDivElement>(null), reduced = useReducedMotion();
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, springOptions), sy = useSpring(y, springOptions);
  const direction = isRevese ? -1 : 1;
  const rx = useTransform(sy, [-0.5, 0.5], [-rotationFactor * direction, rotationFactor * direction]);
  const ry = useTransform(sx, [-0.5, 0.5], [rotationFactor * direction, -rotationFactor * direction]);
  const transform = useMotionTemplate`perspective(1000px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  function move(event: PointerEvent<HTMLDivElement>) {
    if (reduced || event.pointerType !== "mouse" || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    x.set((event.clientX - rect.left) / rect.width - 0.5);
    y.set((event.clientY - rect.top) / rect.height - 0.5);
  }
  function reset() { x.set(0); y.set(0); }
  return <motion.div ref={ref} className={className} style={{ ...style, transformStyle: "preserve-3d", transform: reduced ? "none" : transform }} onPointerMove={move} onPointerLeave={reset} onPointerCancel={reset}>{children}</motion.div>;
}
