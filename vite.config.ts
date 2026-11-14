import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@onedesk/plugin-api": fileURLToPath(new URL("./src/plugin-api/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "safari14",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    environment: "node",
    include: process.env.ONEDESK_PERF ? ["src/**/*.perf.test.{ts,tsx}"] : ["src/**/*.test.{ts,tsx}"],
    exclude: process.env.ONEDESK_PERF ? [] : ["src/**/*.perf.test.{ts,tsx}", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/kernel/**/*.ts", "src/plugin-api/**/*.ts"],
      exclude: ["**/*.test.ts", "**/testing/**"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
