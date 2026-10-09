# Bastion web

React 19 + TypeScript + Vite. Wenvy’s ink-and-vermillion design: paper sections, brush illustrations, Big Shoulders Display, Fraunces, Spline Sans Mono, and Caveat. Upstream styles live in `src/wenvy.css`, working-surface styles in `src/workspace.css`, and Bastion adaptations in `src/index.css`. See [frontend provenance](THIRD_PARTY.md).

## Run

From the repository root:

```bash
pnpm --filter @bastion/web dev
pnpm --filter @bastion/web build
```

Landing and architecture pages render without backend configuration. Console and Arena require `VITE_API_URL` in the root `.env`, a running API, and credentials issued by that API. Operator tokens are entered into the console, never bundled into frontend environment variables.

## Pages

- `/`: Wenvy-style landing, security boundaries, live event-journal shell, and Arena entry.
- `/architecture`: implementation and security boundaries.
- `/dashboard`: projects, workflow JSON import, protected run launch, provenance graph, event journal, incident quarantine, recovery plan review and approval.
- `/runs/:id`: console with that run selected.
- `/arena`: join a room, host a registered workflow, and Originkit Slice Blade warm-up.
- `/arena/:id`: QR invitation, room presence, phase countdown, host controls, private action cards, live graph, and recorded outcome.

Barba owns document navigation. Each transition unmounts the current React root and mounts the next page into the fetched container. React Query and in-memory credentials survive transitions; a browser refresh clears credentials. Static hosting must rewrite these routes to `index.html`.

All run/room records, targets, cards, metrics, and outcomes come from backend responses or persisted events. There is no simulated security run. Slice Blade is a separate visual mini-game and does not represent security outcomes.

## Components and motion

Wenvy components live in `src/components/wenvy`. Its illustration, typography, section layout, textures, and Framer Motion reveals are adapted for Bastion. The existing Slice Blade warm-up remains in Arena with the new palette; other Originkit components remain available in source. Reduced motion disables decorative transforms and page fades. Fonts use Google Fonts with local fallback stacks.

Tokens and reusable controls are shared across pages. API calls live in `src/lib/api.ts`; Socket.IO snapshot/event handling lives in `src/lib/useRun.ts`. REST commands use the shared contract definitions and generated command IDs. Approval controls display the bound recovery plan before submitting its digest.

No API credentials are checked into frontend source or stored in browser storage. Host/player credentials stay in memory for the current visit; a host invitation opens a separate player tab without sharing the host token.
