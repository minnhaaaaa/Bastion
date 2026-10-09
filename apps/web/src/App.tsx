import { Landing } from "./pages/Landing";
import { lazy, Suspense } from "react";
const Architecture = lazy(() =>
  import("./pages/Architecture").then((m) => ({ default: m.Architecture })),
);
const Console = lazy(() =>
  import("./pages/Console").then((m) => ({ default: m.Console })),
);
const Arena = lazy(() =>
  import("./pages/Arena").then((m) => ({ default: m.Arena })),
);
import { SessionProvider } from "./lib/session";
import { Footer, Header } from "./components/ui";
export function App({ path }: { path: string }) {
  const content =
    path === "/" ? (
      <Landing />
    ) : path === "/architecture" ? (
      <Architecture />
    ) : path === "/dashboard" || path.startsWith("/runs/") ? (
      <Console
        runId={path.startsWith("/runs/") ? path.split("/")[2] : undefined}
      />
    ) : path === "/arena" || path.startsWith("/arena/") ? (
      <Arena roomId={path.split("/")[2]} />
    ) : (
      <>
        <Header />
        <main id="main" className="container architecture">
          <h1>Page not found.</h1>
          <a className="button" href="/">
            Back to Bastion
          </a>
        </main>
        <Footer />
      </>
    );
  return (
    <SessionProvider>
      <Suspense
        fallback={
          <main id="main" tabIndex={-1} className="page-loading" role="status">
            Opening Bastion…
          </main>
        }
      >
        {content}
      </Suspense>
    </SessionProvider>
  );
}
