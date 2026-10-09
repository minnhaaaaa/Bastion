# Project rules

- **Zero hardcoded data.** Nothing in the codebase may contain hardcoded data: no canned events, mock streams, fixture JSON, sample runs, hardcoded agents/tasks/sources/capabilities/policy rules, fallback hosts/ports/credentials, or placeholder numbers in the UI. Workflows (agents, tasks, sources, capabilities, policy rules, attack payloads) are data submitted via `POST /api/workflows` and stored in Postgres; configuration comes only from required environment variables; everything the UI shows is real-time from persisted backend events. Test doubles and generated test data are allowed **only inside automated tests**. Demo content will be decided later and will also be loaded as data, not code.
- `packages/contracts` is the shared spec; changes need all three team members' ack (see TEAM_PLAN.md).

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
