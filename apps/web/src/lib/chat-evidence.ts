import type { RunEvent, RunSnapshot } from "@bastion/contracts";

/** Only terminal tasks answer the user; intermediate artifacts remain in Results. */
export function chatArtifacts(snapshot: RunSnapshot) {
  const upstream = new Set(Object.values(snapshot.tasks).flatMap(task => task.declaredDeps));
  return Object.values(snapshot.artifacts).filter(artifact => {
    const execution = snapshot.executions[artifact.producerExecutionId];
    return execution && !upstream.has(execution.taskId) && snapshot.latestExecutionByTask[execution.taskId] === execution.id;
  });
}

export function progressMessage(event: RunEvent): string | null {
  switch (event.type) {
    case "run.created": return "Starting your task…";
    case "run.planned": return "The plan is ready. Starting work…";
    case "task.state_changed": return event.payload.to === "RUNNING" ? "Working on your task…" : null;
    case "tool.decided": return event.payload.decision === "DENY" ? "An action was blocked. Review Security for details." : null;
    case "tool.approval_requested": return "An action needs your approval.";
    case "incident.opened": return "A security incident needs your attention.";
    case "containment.applied": return "Affected work has been contained.";
    case "recovery.completed": return "Recovery verification has finished. Review Security for the outcome.";
    case "run.status_changed": return event.payload.to === "COMPLETED" ? "Work completed." : event.payload.to === "RECOVERED" ? "Work recovered." : event.payload.to === "FAILED" ? "The run stopped. Review Activity for details." : null;
    default: return null;
  }
}
