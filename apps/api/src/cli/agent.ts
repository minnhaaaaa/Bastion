/** Local provider setup. Credentials stay on the controller; no workflow is executed. */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isAbsolute } from "node:path";
import { loginCodex, piProviderModels } from "@bastion/runtime-pi";

async function main() {
  try { process.loadEnvFile(new URL("../../../../.env", import.meta.url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const command = process.argv[2];
  const provider = process.env.PI_PROVIDER?.trim();
  if (!provider) throw new Error("Set PI_PROVIDER in the root .env");
  if (command === "models") {
    const models = piProviderModels(provider);
    if (!models.length) throw new Error("Provider is not in the installed Pi registry");
    for (const model of models) console.log(`${model.id}\t${model.baseUrl}`);
    return;
  }
  if (command !== "login") throw new Error("Use pnpm agent:login or pnpm agent:models");
  if (provider !== "openai-codex" || process.env.PI_AUTH_MODE !== "oauth") {
    throw new Error("Login requires PI_PROVIDER=openai-codex and PI_AUTH_MODE=oauth. Claude/OpenRouter use PI_API_KEY.");
  }
  const authFile = process.env.PI_AUTH_FILE?.trim();
  if (!authFile || !isAbsolute(authFile)) throw new Error("Set PI_AUTH_FILE to an absolute credentials-file path");
  if (!stdin.isTTY) throw new Error("Run pnpm agent:login in your interactive terminal");
  const prompt = createInterface({ input: stdin, output: stdout });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  try {
    await loginCodex(authFile, {
      onAuth: ({ url, instructions }) => {
        console.log("Open this sign-in URL in your browser:");
        console.log(url);
        if (instructions) console.log(instructions);
      },
      onPrompt: ({ message }) => prompt.question(`${message}: `, { signal: abort.signal }),
      onDeviceCode: ({ verificationUri, userCode }) => {
        console.log(`Open ${verificationUri} and enter the code: ${userCode}`);
      },
      onSelect: async ({ message, options }) => {
        console.log(message);
        for (const option of options) console.log(`${option.id}: ${option.label}`);
        const selected = (await prompt.question("Choose an option ID (blank cancels): ", { signal: abort.signal })).trim();
        return options.some(option => option.id === selected) ? selected : undefined;
      },
      onProgress: message => console.log(message),
      signal: abort.signal,
    });
    console.log("Codex connected. Run pnpm config:check before starting the API.");
  } finally {
    process.removeListener("SIGINT", stop);
    prompt.close();
  }
}
void main().catch(error => {
  // Never print provider responses, credentials, or stack traces from the login exchange.
  const message = error instanceof Error && /^(Set |Use |Provider |Login |Run |Credentials )/.test(error.message)
    ? error.message : "Codex sign-in failed or was cancelled. Retry pnpm agent:login.";
  console.error(message);
  process.exitCode = 1;
});
