/**
 * Single place where GSAP and its plugins are registered (see .claude/skills/gsap-*).
 * All page animation goes through useGSAP with a scope so Barba unmounts revert everything.
 */
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { CustomEase } from "gsap/CustomEase";

gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText, DrawSVGPlugin, ScrambleTextPlugin, CustomEase);

CustomEase.create("rampart", "0.22,1,0.36,1");
CustomEase.create("slam", "0.7,0,0.2,1");
gsap.defaults({ ease: "rampart", duration: 0.9 });

/** Use with gsap.matchMedia(): animations live under MOTION, static states under REDUCED. */
export const MOTION = "(prefers-reduced-motion: no-preference)";
export const REDUCED = "(prefers-reduced-motion: reduce)";
export const prefersReduced = () => window.matchMedia(REDUCED).matches;

export { gsap, useGSAP, ScrollTrigger, SplitText };
