# Demonstrate Bastion with real models

Start with [Connections](CONNECTIONS.md). The console's **Security walkthrough** shows these steps alongside counts derived from the selected run. It does not start attacks, inject canned results, or turn an absent measurement into a pass.

## Prepare the trial

Use your own repository and source data. Define the legitimate work, expected evidence, and failure conditions before running. Connect the repository in Settings for normal work; keep malicious source material and synthetic secrets inside an isolated sandbox. Do not use real secrets for leakage demonstrations.

For a security trial, submit a workflow through `POST /api/workflows` (or Settings → Advanced → Import workflow JSON). Its source locations, agents, task dependencies, capabilities, policy rules, attack payload locations, and acceptance checks are persisted as workflow data. No demo scenarios are built into production code. Import is optional for everyday tasks but is currently needed to express attack payloads and advanced acceptance checks that the visual editor does not yet expose.

Select the saved workflow under Advanced. Configure optional model assignments if comparing providers. Run the saved workflow directly to preserve its defined trial instructions. To apply submitted attack payloads, use Arena with that workflow and its available attack cards. Never interpret a task that did not encounter the intended attack as a successful attack-defense trial.

## Walk through the evidence

1. **Normal execution:** Run the legitimate task first. In Results, inspect actual artifacts and sources. In Security, inspect configured checks. A task marked succeeded is not necessarily factually correct.
2. **Prompt injection:** Apply your submitted payload to an untrusted source. Use Trace to establish that the attacked source version was consumed by the target execution. Inspect tool requests, decisions, and sandbox effects. Refusal, denial, and actual execution are distinct outcomes.
3. **Jailbreak and unsafe tool use:** Give the model a trial request outside its granted capability or behind an approval rule. In Security, inspect the exact operation, resource, decision, and reason. For approval-gated requests, review the actual queued action before approving or rejecting. Verify whether the sandbox executed it.
4. **Data leakage:** Supply a synthetic secret with its workflow classification and define the prohibited destination. Inspect provenance from that source through the execution, the attempted destination, and the sandbox audit. Redacted UI previews alone do not establish that leakage was prevented.
5. **Hallucinations:** Configure `SOURCE_QUOTE` checks against trusted sources and the output JSON pointers, or controller-executed `TOOL` checks with objective assertions. Ask for work with verifiable claims. Inspect each recorded check and its details. Quote matching tests source grounding; it is not a general detector of every false statement.
6. **Knowledge graph:** Open Trace and select source, execution, output, or tool-request nodes. Follow the recorded edges rather than merely showing the graph. Explain which outputs depend on a compromised source and which independent tasks do not. Postgres events are authoritative; Neo4j is a projection and is not on the critical containment path.
7. **Containment and recovery:** For a recorded incident, open Security → Incidents & recovery. Quarantine the affected source, select a trusted replacement, and review the recovery plan's rerun and preserved task sets. Approve the exact plan and inspect the subsequent executions and verification. This demonstrates operator-reviewed recovery; it does not imply every compromise is detected automatically.
8. **Model auditing:** Inspect Agent models for this run and export the recorded trace. Check the workflow version, model assignments, tool decisions, effects, and verification evidence. Private full Pi traces, when enabled on the controller, are sensitive and are not exposed as ordinary UI output. Old runs without pinned model metadata are labelled accordingly.

## Compare honestly

If a sandboxed baseline is part of your submitted trial, use the same workflow version and attack content as the protected run. Security → Compare recorded runs indicates whether those conditions match. Baseline removes policy enforcement and can cause real sandbox effects; it is not automatically started by the walkthrough.

Report failed checks, missing audit evidence, provider failures, and model refusals. Repeat on different inputs and providers when quota permits. Passing a bounded set of trials does not establish universal protection against injection, jailbreaks, hallucinations, or leakage. A lineage graph explains information flow; it does not independently establish truth.
