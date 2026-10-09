/** Metadata for an explicitly configured OpenAI-compatible endpoint, never a fallback model. */
export type CustomModel = {
  api: "openai-completions";
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};
export function customModelFromEnv(raw: string): CustomModel {
  const invalid = () => new Error("Invalid PI_CUSTOM_MODEL_JSON: expected explicit API, input modalities, reasoning, token limits, and costs");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const model = value as Record<string, unknown>;
  const keys = ["api", "reasoning", "input", "contextWindow", "maxTokens", "cost"];
  if (Object.keys(model).length !== keys.length || Object.keys(model).some(key => !keys.includes(key))) throw invalid();
  if (model.api !== "openai-completions" || typeof model.reasoning !== "boolean" || !Array.isArray(model.input) || !model.input.length || model.input.some(item => item !== "text" && item !== "image")) throw invalid();
  if (![model.contextWindow, model.maxTokens].every(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0)) throw invalid();
  const cost = model.cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) throw invalid();
  const costKeys = ["input", "output", "cacheRead", "cacheWrite"];
  if (Object.keys(cost).length !== costKeys.length || Object.keys(cost).some(key => !costKeys.includes(key)) || Object.values(cost).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw invalid();
  return model as CustomModel;
}
