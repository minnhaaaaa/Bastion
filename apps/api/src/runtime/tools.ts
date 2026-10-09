import { Type, type TSchema } from "@sinclair/typebox";
import type { GatewayTool } from "@bastion/runtime-pi";

/**
 * Argument schemas per *implemented* sandbox operation (tool implementation metadata, not data).
 * Which tool names exist and which operation each maps to come from SANDBOX_TOOL_OPERATIONS.
 */
const OPERATIONS: Record<string, { description: string; parameters: TSchema }> = {
  "fs.read": { description: "Read a UTF-8 file inside the workspace.", parameters: Type.Object({ path: Type.String() }) },
  "fs.write": {
    description: "Write a UTF-8 file inside the workspace.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  },
  "net.http": { description: "HTTP GET a URL. Only approved origins are reachable.", parameters: Type.Object({ url: Type.String() }) },
  "proc.exec": {
    description: "Run an approved executable with arguments (no shell).",
    parameters: Type.Object({ executable: Type.String(), argv: Type.Array(Type.String()) }),
  },
};

export function gatewayToolsFor(toolOperations: Record<string, string>): GatewayTool[] {
  return Object.entries(toolOperations).map(([name, operation]) => {
    const op = OPERATIONS[operation];
    if (!op) throw new Error(`SANDBOX_TOOL_OPERATIONS: unsupported operation ${operation} for tool ${name}`);
    return { name, label: name, description: op.description, parameters: op.parameters };
  });
}
