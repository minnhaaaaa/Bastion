/**
 * @bastion/knowledge-graph — owner: Member 3
 * Neo4j projector (idempotent, replayable) + impactSet Cypher. Constraints in schema.cypher.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseSchema } from "./projector";

export * from "./projector";

export async function loadSchemaStatements(): Promise<string[]> {
  return parseSchema(await readFile(fileURLToPath(new URL("../schema.cypher", import.meta.url)), "utf8"));
}
