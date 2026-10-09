import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import barba from "@barba/core";
import { App } from "./App";
import { gsap, ScrollTrigger, prefersReduced } from "./lib/motion";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/* Barba swaps containers; each container hosts its own React root. */
const roots = new Map<HTMLElement, Root>();
function mount(container: HTMLElement, path: string) {
  const target = container.querySelector<HTMLElement>(".app-mount")!;
  const root = createRoot(target);
  roots.set(container, root);
  root.render(
    <QueryClientProvider client={queryClient}>
      <App path={path} />
    </QueryClientProvider>,
  );
}
function unmount(container: HTMLElement) {
  // Unmounting runs every useGSAP cleanup: tweens, SplitText and ScrollTriggers are reverted.
  roots.get(container)?.unmount();
  roots.delete(container);
}
/** Let React commit and fonts settle, then re-measure every ScrollTrigger once. */
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        ScrollTrigger.refresh();
        resolve();
      }),
    ),
  );

/* ── The gate: two crenellated crimson leaves and the drawn emblem ── */
const gate = document.querySelector<HTMLElement>(".gate")!;
const top = gate.querySelector<HTMLElement>(".gate__leaf--top")!;
const bottom = gate.querySelector<HTMLElement>(".gate__leaf--bottom")!;
const crest = gate.querySelectorAll<SVGElement>(".gate__crest polygon, .gate__crest rect");
const label = gate.querySelector<HTMLElement>(".gate__label")!;
gsap.set(top, { transformOrigin: "50% 0%" });
gsap.set(bottom, { transformOrigin: "50% 100%" });

function closeGate(destination: string) {
  label.textContent = destination;
  return gsap
    .timeline()
    .set(gate, { visibility: "visible" })
    .fromTo([top, bottom], { scaleY: 0 }, { scaleY: 1, duration: 0.55, ease: "slam", stagger: 0.04 })
    .fromTo(crest, { drawSVG: "50% 50%", autoAlpha: 1 }, { drawSVG: "0% 100%", duration: 0.5, stagger: 0.05 }, "-=0.2")
    .fromTo(label, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.3 }, "<");
}
function openGate() {
  return gsap
    .timeline()
    .to([crest, label], { autoAlpha: 0, duration: 0.2 })
    .to([top, bottom], { scaleY: 0, duration: 0.7, ease: "rampart", stagger: 0.03 })
    .set(gate, { visibility: "hidden" });
}
const nameOf = (path: string) =>
  path === "/" ? "Bastion" : path.startsWith("/arena") ? "Arena" : path === "/architecture" ? "Architecture" : "Console";

// Web fonts change text widths (pinned/horizontal sections): re-measure once they are ready.
void document.fonts?.ready.then(() => ScrollTrigger.refresh());

const initial = document.querySelector<HTMLElement>('[data-barba="container"]')!;
mount(initial, window.location.pathname);

barba.init({
  preventRunning: true,
  prevent: ({ el }) => el.hasAttribute("data-barba-prevent"),
  transitions: [
    {
      name: "bastion-gate",
      async once() {
        if (prefersReduced()) return;
        // Initial load: start sealed, then open onto the page.
        gsap.set(gate, { visibility: "visible" });
        gsap.set([top, bottom], { scaleY: 1 });
        gsap.set(crest, { drawSVG: "0% 100%" });
        label.textContent = nameOf(window.location.pathname);
        await settle();
        await openGate().delay(0.35);
      },
      async leave({ current, next }) {
        current.container.inert = true;
        if (!prefersReduced()) await closeGate(nameOf(new URL(next.url.href, window.location.origin).pathname));
        unmount(current.container);
      },
      async enter({ next }) {
        const destination = new URL(next.url.href, window.location.origin);
        mount(next.container, destination.pathname);
        window.scrollTo(0, 0);
        await settle();
        if (destination.hash) document.getElementById(decodeURIComponent(destination.hash.slice(1)))?.scrollIntoView();
        if (!prefersReduced()) await openGate();
        next.container.querySelector<HTMLElement>("#main")?.focus({ preventScroll: true });
      },
    },
  ],
});
