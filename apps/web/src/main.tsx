import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import barba from "@barba/core";
import { App } from "./App";
import "./index.css";
import { isDesktop, navigate } from "./lib/navigation";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
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
const reduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
async function fade(container: HTMLElement, incoming: boolean) {
  if (reduced()) return;
  await container.animate(
    incoming
      ? [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "translateY(0)" },
        ]
      : [{ opacity: 1 }, { opacity: 0 }],
    { duration: incoming ? 260 : 160, easing: "ease-out" },
  ).finished;
}
const initial = document.querySelector<HTMLElement>(
  '[data-barba="container"]',
)!;
if (isDesktop() && window.location.pathname === "/") history.replaceState(null, "", "/dashboard");
mount(initial, window.location.pathname);
if (isDesktop()) {
  const showPage = () => {
    roots.get(initial)?.unmount();
    mount(initial, window.location.pathname);
    window.scrollTo(0, 0);
    if (window.location.hash) document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView();
  };
  window.addEventListener("popstate", showPage);
  document.addEventListener("click", event => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.download) return;
    const url = new URL(link.href);
    if (url.protocol !== window.location.protocol || url.host !== window.location.host) { event.preventDefault(); return; }
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
} else barba.init({
  preventRunning: true,
  prevent: ({ el }) => el.hasAttribute("data-barba-prevent"),
  transitions: [
    {
      name: "bastion-boundary",
      async once({ next }) {
        await fade(next.container, true);
      },
      async leave({ current }) {
        document.getElementById("transition-loader")!.classList.add("active");
        current.container.inert = true;
        await fade(current.container, false);
        roots.get(current.container)?.unmount();
        roots.delete(current.container);
      },
      async enter({ next }) {
        const destination = new URL(next.url.href, window.location.origin);
        const path = destination.pathname;
        mount(next.container, path);
        window.scrollTo(0, 0);
        await fade(next.container, true);
        if (destination.hash)
          document
            .getElementById(decodeURIComponent(destination.hash.slice(1)))
            ?.scrollIntoView();
        document
          .getElementById("transition-loader")!
          .classList.remove("active");
        next.container
          .querySelector<HTMLElement>("#main")
          ?.focus({ preventScroll: true });
      },
    },
  ],
});
