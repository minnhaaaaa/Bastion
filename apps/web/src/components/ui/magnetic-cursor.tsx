import { useEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";

/** Magnetic, velocity-stretched cursor adapted from the supplied component. */
export function MagneticCursor({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), cursor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = gsap.matchMedia();
    media.add("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)", () => {
      const element = cursor.current, scope = root.current;
      if (!element || !scope) return;
      let x = 0, y = 0, targetX = 0, targetY = 0, visible = false;
      let magnetic: HTMLElement | null = null;
      gsap.set(element, { xPercent: -50, yPercent: -50, opacity: 0 });
      const move = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return;
        targetX = event.clientX; targetY = event.clientY;
        if (!visible) { x = targetX; y = targetY; visible = true; gsap.set(element, { opacity: 1 }); }
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>("a, button, [data-magnetic]") : null;
        const next = target && scope.contains(target) ? target : null;
        if (next !== magnetic) {
          magnetic = next;
          const bounds = magnetic?.getBoundingClientRect();
          gsap.to(element, { width: bounds ? bounds.width + 12 : 22, height: bounds ? bounds.height + 12 : 22, borderRadius: bounds ? 12 : 50, duration: .25, overwrite: "auto" });
        }
      };
      const hide = () => { visible = false; magnetic = null; gsap.set(element, { opacity: 0, width: 22, height: 22 }); };
      const tick = (_time: number, deltaTime: number) => {
        if (!visible) return;
        const bounds = magnetic?.getBoundingClientRect();
        const tx = bounds ? bounds.left + bounds.width / 2 + (targetX - bounds.left - bounds.width / 2) * .15 : targetX;
        const ty = bounds ? bounds.top + bounds.height / 2 + (targetY - bounds.top - bounds.height / 2) * .15 : targetY;
        const amount = 1 - Math.pow(.8, deltaTime / (1000 / 60));
        const dx = (tx - x) * amount, dy = (ty - y) * amount;
        x += dx; y += dy;
        const speed = magnetic ? 0 : Math.min(Math.hypot(dx, dy) * .025, .65);
        gsap.set(element, { x, y, rotation: magnetic ? 0 : Math.atan2(dy, dx) * 180 / Math.PI, scaleX: 1 + speed, scaleY: 1 - speed * .4 });
      };
      scope.addEventListener("pointermove", move); scope.addEventListener("pointerleave", hide);
      window.addEventListener("blur", hide); document.addEventListener("visibilitychange", hide);
      gsap.ticker.add(tick);
      return () => {
        gsap.ticker.remove(tick); gsap.killTweensOf(element);
        scope.removeEventListener("pointermove", move); scope.removeEventListener("pointerleave", hide);
        window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", hide);
      };
    });
    return () => media.revert();
  }, []);
  return <div ref={root} className="landing-cursor-scope">{children}<div ref={cursor} className="landing-fluid-cursor" aria-hidden="true" /></div>;
}
