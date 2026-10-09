# Bastion desktop client

The desktop target is a Tauri 2 native webview client of the existing Bastion controller. It bundles the frontend, not the API, Postgres, Neo4j, Docker worker or model runtime. Workflow agents, security decisions, approvals, provenance and recovery run on the controller. This keeps those services off the client machine. Lower resource usage than another application is a target, not a measured result.

Install Rust/Cargo and the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/). On Ubuntu:

```sh
sudo apt-get install cargo rustc libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev
```

The installed Rust version must meet the requirements of the resolved Tauri dependencies. `pnpm desktop:info` checks the environment. From the repository root, set `VITE_API_URL` to the controller origin in `.env`. `WEB_ORIGIN` supplies the development frontend address. Then use:

```sh
pnpm desktop:dev
pnpm desktop:build
```

Stop a browser Vite server on `WEB_ORIGIN` before `desktop:dev`; Tauri starts its own server on that explicit port. Build output is under `apps/web/src-tauri/target/release/bundle/`, with Linux deb/AppImage targets. Native builds remain unverified until the prerequisites are installed and compilation completes. Other operating systems require their own build hosts and bundle target configuration.

The controller must explicitly allow the packaged client's origin using `WEB_ADDITIONAL_ORIGINS`. Platform origins are `tauri://localhost`, `http://tauri.localhost` or `https://tauri.localhost`; configure only the clients you deploy. Restart the controller after changes. Production controllers should use HTTPS/WSS. The build generates a CSP that limits network connections to the configured controller and its socket endpoint. No native filesystem/shell/process plugins or IPC commands are granted. Agent tools remain on the controller's security gateway.

The operator token stays in frontend memory. Provider keys are server-only and are not shipped in the frontend bundle. The packaged controller endpoint is chosen at build time; changing it requires rebuilding. The app opens at the workspace and uses local history navigation; the browser site retains Barba transitions. External navigation is blocked in the desktop frontend. Fonts use the existing Google Fonts stylesheet with local fallbacks; offline font embedding is not implemented.

The controller already schedules multiple workflow agents. Provider selection is currently one configured provider/model per controller process; mixed Codex/Claude models per agent are not yet implemented.

## Workspace interface

The console uses a compact three-pane workspace: projects and recent runs, task activity with a composer, and a Results / Security / Trace inspector. The workspace inherits the website’s ink, cream, and deep-red palette, Instrument Serif display headings, and IBM Plex Mono controls, while retaining compact desktop spacing. On narrow windows, inspection moves below the task pane and the sidebar can be hidden.

After operator authentication, create or select a project and describe a task. The composer requests a live model plan, saves its validated definition through `POST /api/workflows`, then starts a protected run. Agent roles and task steps come from that model response, not a coded template. Without a repository connection, new plans have no source, file, network, or process grants. Connected repositories supply tracked file sources and the access selected by the operator; they do not grant network or process access. They can work with the user's supplied information; repository work uses a one-time project connection in Settings, or an explicitly selected advanced workflow.

**Advanced** in the composer can select an existing workflow and its exact version as the boundary for planning. The planner can adapt task instructions only: every agent, capability, source, dependency, retry policy, and verification check remains unchanged. **Run the saved workflow directly** retains the previous task-update behavior without a planning call. The visual editor remains available as **Advanced workflows**. Creating a project no longer opens that editor automatically.

Planning is an authenticated, owner-scoped controller operation. It uses the configured live Pi model with no tools and a separate planning system prompt. Invalid plans fail without starting a run; no canned plan substitutes for an unavailable model. The resulting workflow is persisted before execution, and workflow versions remain immutable. Completed runs can supply their redacted output previews as context for a follow-up. Follow-ups start new protected runs with the original workflow permissions and checks; they do not append to a prior model session or claim cross-run graph lineage.

Approval cards appear in the activity pane. Review loads the operator-only exact target and arguments. Allow once / Deny send the reviewed action digest and tool request ID; changed, resolved, or expired actions cannot be approved. Recovery planning and approvals remain available in Security. Results show recorded redacted artifact/source previews; Trace opens the provenance graph and evidence inspector.

Existing definitions can be imported under **Settings → Advanced**. Provider sign-in and model selection remain controller-side; Settings shows the configured provider/model without claiming its quota is available. Project repository access is saved in Settings, with the same dropdown control used elsewhere. The UI reports `/health` runtime status; it does not grant native terminal or filesystem access or simulate those surfaces. No shared contract changes are required.


## Validation and remaining limits

Offline verification covers the real scheduler, policy gateway, sandbox worker, persisted journal, project ownership, repository connection confinement, exact tool-check receipts, and follow-up preview selection. Native packaging still requires Rust/Cargo and Linux WebKit/RSVG dependencies; administrator installation could not run unattended on the development host. The live-provider and deployed-controller evaluation commands are documented in `sandbox/README.md` and `apps/api/README.md`; model access is available through the explicitly configured provider. See the current evaluation record in `LIVE_VALIDATION.md` at the repository root for measured results and limits.

Provider credentials/sign-in are still configured on the controller, not through a desktop account-connection screen. Mixed providers per agent, full conversational sessions, cross-run graph lineage, automatic repository cloning/mounting, and general factual verification remain separate work. Source quotes and command checks verify their declared conditions; they are not a guarantee against every hallucination or attack.

Security includes the pinned workflow policy, JSON trace export, and comparison against recorded opposite-mode runs of the same workflow. Comparison reports version and attack-hash mismatches explicitly. Arena hosts can pause/resume active rounds and reset a revealed round.
