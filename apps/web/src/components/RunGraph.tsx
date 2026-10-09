import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  type Node,
  type Edge,
} from "@xyflow/react";
import { toGraphView, type RunSnapshot } from "@bastion/contracts";
import "@xyflow/react/dist/style.css";
import { Empty } from "./ui";
export function RunGraph({
  snapshot,
  onSelect,
}: {
  snapshot?: RunSnapshot;
  onSelect?: (id: string) => void;
}) {
  const graph = useMemo(() => {
    if (!snapshot) return { nodes: [], edges: [] };
    const view = toGraphView(snapshot);
    const levels = new Map(view.nodes.map((n) => [n.id, 0]));
    // Dependency layout; cap relaxation so provenance cycles cannot stall the interface.
    for (let pass = 0; pass < view.nodes.length; pass++) {
      let changed = false;
      for (const edge of view.edges) {
        const level = Math.min(
          view.nodes.length,
          (levels.get(edge.source) ?? 0) + 1,
        );
        if (level > (levels.get(edge.target) ?? 0)) {
          levels.set(edge.target, level);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const rows = new Map<number, number>();
    const nodes: Node[] = view.nodes.map((node) => {
      const level = levels.get(node.id) ?? 0;
      const row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      return {
        id: node.id,
        position: { x: level * 265, y: row * 135 },
        data: {
          label: (
            <div className="graph-label">
              <span>{node.label}</span>
              <strong>{node.title}</strong>
              <small>
                {node.decision ??
                  node.securityState ??
                  node.taskState ??
                  "Recorded"}
              </small>
            </div>
          ),
        },
        className:
          node.decision === "DENY" || node.securityState === "QUARANTINED"
            ? "graph-alert"
            : "",
      };
    });
    const edges: Edge[] = view.edges.map((edge) => ({
      ...edge,
      label: edge.relation,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: "#6e727a" },
    }));
    return { nodes, edges };
  }, [snapshot]);
  if (!graph.nodes.length)
    return (
      <Empty title="Your evidence graph starts here">
        Run a workflow to see recorded source, task, artifact, and tool
        dependencies.
      </Empty>
    );
  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_, node) => onSelect?.(node.id)}
      colorMode="dark"
      minZoom={0.15}
    >
      <Background color="#292d30" gap={28} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
