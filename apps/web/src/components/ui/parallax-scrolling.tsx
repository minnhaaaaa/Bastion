import { useRef, type ReactNode } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import Lenis from "@studio-freight/lenis";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/** Scoped adaptation of the supplied layered parallax; one scroll driver per landing page. */
export function ParallaxComponent({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const lenis = new Lenis();
      const tick = (time: number) => lenis.raf(time * 1000);
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(tick);
      root.current?.querySelectorAll<HTMLElement>("[data-parallax-layers]").forEach(section => {
        const timeline = gsap.timeline({ scrollTrigger: { trigger: section, start: "clamp(top bottom)", end: "clamp(bottom top)", scrub: true, invalidateOnRefresh: true } });
        section.querySelectorAll<HTMLElement>("[data-parallax-layer]").forEach(layer => {
          const distance = Number(layer.dataset.parallaxLayer);
          if (Number.isFinite(distance)) timeline.fromTo(layer, { y: -distance }, { y: distance, ease: "none" }, 0);
        });
      });
      let active = true;
      void document.fonts.ready.then(() => { if (active) ScrollTrigger.refresh(); });
      return () => { active = false; gsap.ticker.remove(tick); lenis.off("scroll", ScrollTrigger.update); lenis.destroy(); };
    });
    return () => media.revert();
  }, { scope: root });
  return <div ref={root} className="landing-parallax">{children}</div>;
}
