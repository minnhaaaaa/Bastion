import { useQuery } from "@tanstack/react-query";
import { env } from "./env";

// Placeholder (Member 1 replaces this). Everything shown comes live from the API — no bundled data.
export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch(`${env.apiUrl}/health`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      return (await res.json()) as { ok: boolean; startedAt: string; now: string };
    },
    refetchInterval: 5000,
  });

  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <h1 className="text-3xl font-bold">SPLITBRAIN</h1>
      <dl className="mt-6 grid max-w-md grid-cols-2 gap-2 text-sm">
        <dt className="text-neutral-400">API</dt>
        <dd>{health.isPending ? "connecting…" : health.isError ? `unreachable (${health.error.message})` : "connected"}</dd>
        {health.data && (
          <>
            <dt className="text-neutral-400">Server time</dt>
            <dd>{health.data.now}</dd>
          </>
        )}
      </dl>
    </main>
  );
}
