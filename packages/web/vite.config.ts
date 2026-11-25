import { defineConfig } from "vite";

// The built screen is served by the core's own server; in dev the API is asked through to it.
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/api": "http://127.0.0.1:8801" } },
});
