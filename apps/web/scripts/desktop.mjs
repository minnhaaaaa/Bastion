import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = new URL("../../../", import.meta.url);
process.loadEnvFile(new URL(".env", root));
const mode = process.argv[2];
if (!["dev", "build", "info"].includes(mode)) throw new Error("Use desktop:dev, desktop:build or desktop:info");
const required = key => { if (!process.env[key]?.trim()) throw new Error(`Missing ${key}`); return process.env[key]; };
const controller = new URL(required("VITE_API_URL"));
if (!["http:", "https:"].includes(controller.protocol) || controller.username || controller.password || controller.pathname !== "/" || controller.search || controller.hash) throw new Error("VITE_API_URL must be a controller origin without credentials");
const socket = new URL(controller); socket.protocol = controller.protocol === "https:" ? "wss:" : "ws:";
const connect = `${controller.origin} ${socket.origin}`;
const overlay = { app: { security: { csp: `default-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' ${connect}` } } };
if (mode === "dev") {
  const dev = new URL(required("WEB_ORIGIN"));
  if (!["http:", "https:"].includes(dev.protocol)) throw new Error("Invalid WEB_ORIGIN");
  overlay.build = { devUrl: dev.origin, beforeDevCommand: { script: `pnpm dev --host ${dev.hostname} --port ${dev.port} --strictPort`, wait: false } };
} else if (mode === "build") overlay.build = { beforeBuildCommand: "pnpm build" };
const path = new URL("../src-tauri/desktop.generated.json", import.meta.url);
writeFileSync(path, JSON.stringify(overlay, null, 2));
// This overlay contains origins only; no server credentials are bundled.
const child = spawn("pnpm", ["exec", "tauri", mode, ...(mode === "info" ? [] : ["--config", fileURLToPath(path)])], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: process.env, stdio: "inherit" });
child.on("exit", code => { process.exitCode = code ?? 1; });
child.on("error", () => { console.error("Could not start the desktop CLI"); process.exitCode = 1; });
