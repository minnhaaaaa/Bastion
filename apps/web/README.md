# Bastion web

React 19 + TypeScript + Vite, with **Barba.js** page transitions and **GSAP** animation. This is Bastion's own "Rampart" design: crimson and oxblood on a cool red-black, Archivo Expanded display type, Instrument Sans and JetBrains Mono, notched geometry, battlement edges, blueprint grids and a star-fort emblem.

## Run

From the repository root:

```bash
pnpm --filter @bastion/web dev
pnpm --filter @bastion/web build
```

Landing and architecture pages render without a backend. Console and Arena need `VITE_API_URL` in the root `.env`, a running API, and credentials issued by that API. Operator tokens are typed into the console; they are never bundled or stored in browser storage.

## Pages

- `/` — landing: hero, threats, doctrine (pinned horizontal scroll), enforcement boundaries, live event journal, Arena call to action.
- `/architecture` — stack, action pipeline and enforcement boundaries.
- `/dashboard`, `/runs/:id` — console: projects, workflow import, protected runs, provenance graph, event journal, incidents, recovery approval.
- `/arena`, `/arena/:id` — join or host a round, QR invitation, presence, phase timer, private cards, live graph, recorded outcome.

Every run, room, card, metric and outcome comes from API responses or persisted events. Nothing is simulated.

## Motion

- `src/lib/motion.ts` registers GSAP plugins once: ScrollTrigger, SplitText, DrawSVG, ScrambleText, CustomEase and `useGSAP`. All animation uses `useGSAP` with a scope, so unmounting reverts every tween, split and ScrollTrigger.
- `gsap.matchMedia()` gates all decorative motion behind `prefers-reduced-motion: no-preference`; reduced-motion users get static, fully visible content.
- `src/main.tsx`: **Barba** owns navigation. The "gate" transition closes two crenellated crimson leaves while drawing the emblem, unmounts the old React root (reverting its animations), mounts the next page, refreshes ScrollTrigger, and opens the gate. Static hosting must rewrite routes to `index.html`.
- GSAP agent skills (official, `npx skills add https://github.com/greensock/gsap-skills`) are installed in `.claude/skills/` for anyone working on animation with Claude Code.

## Styles

- `src/styles/theme.css` — tokens, base elements, buttons, gate.
- `src/styles/site.css` — header, footer, landing, architecture.
- `src/styles/workspace.base.css` + `workspace.skin.css` — console and Arena layout (Member 1) with the Rampart skin.
