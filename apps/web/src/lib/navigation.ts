import barba from "@barba/core";
export const isDesktop = () => "__TAURI_INTERNALS__" in window;
export function navigate(path: string) {
  if (!isDesktop()) { barba.go(path); return; }
  const url = new URL(path, window.location.href);
  if (url.protocol !== window.location.protocol || url.host !== window.location.host) throw new Error("Desktop navigation must stay inside Bastion");
  history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
