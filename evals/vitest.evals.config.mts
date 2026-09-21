import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * A SEPARATE config from the repo's own vitest.config.mts, on purpose:
 * that one's `include: ["src/**\/*.test.ts"]` is what `npm test`/CI runs,
 * and evals must never be swept into that run - they call the real,
 * configured LLM provider (cost, latency, non-determinism) rather than a
 * stubbed client, so they are a manual `npm run eval:*` step, not a test.
 * Same `@` alias as the main config so eval files can import agent code
 * exactly the way the app and its unit tests do.
 */
const repoRoot = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      "@": path.resolve(repoRoot, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    setupFiles: ["evals/setup-env.ts"],
    // Evals call a real model per fixture; give them room past vitest's
    // 5s default before a slow provider (e.g. a cold Ollama model) is
    // mistaken for a hang.
    testTimeout: 60_000,
  },
});
