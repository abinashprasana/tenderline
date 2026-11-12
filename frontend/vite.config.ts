/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The API is served from the same origin in every environment: Caddy proxies these paths in production,
// Vite does it here. Same origin means no CORS, and the OAuth state cookie (path /v1/auth/github) just works.
const API = process.env.TENDERLINE_API ?? "http://localhost:8000";
const proxied = ["/v1", "/healthz", "/readyz", "/docs", "/openapi.json"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(proxied.map((path) => [path, { target: API, changeOrigin: false }])),
  },
  preview: { port: 4173, proxy: Object.fromEntries(proxied.map((path) => [path, { target: API }])) },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
  },
});
