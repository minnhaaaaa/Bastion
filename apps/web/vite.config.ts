import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode, command }) => {
  const envDir = fileURLToPath(new URL("../..", import.meta.url));
  const configured = loadEnv(mode, envDir, "VITE_");
  const target = process.env.VITE_API_URL || configured.VITE_API_URL;
  if (!target) throw new Error("VITE_API_URL is required (see .env.example)");
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid VITE_API_URL");
  return {
  // Read VITE_* vars from the repo-root .env
  envDir,
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  ...(command === "serve" ? { server: { proxy: {
    "/api": { target, changeOrigin: true },
    "/health": { target, changeOrigin: true },
    "/socket.io": { target, changeOrigin: true, ws: true },
  } } } : {}),
  };
});
