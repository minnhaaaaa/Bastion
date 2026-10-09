import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Read VITE_* vars from the repo-root .env
  envDir: "../..",
  plugins: [react(), tailwindcss()],
});
