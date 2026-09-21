/**
 * Vitest (unlike `next dev`/`next build`) does not load .env.local on its
 * own - evals need it for LLM_PROVIDER/credentials/DATABASE_URL, so this
 * loads it into process.env before any eval file runs. Never overrides a
 * variable already set in the real environment (so CI secrets, if this ever
 * runs there, still win over a checked-out .env.local).
 */
import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(import.meta.dirname, "..", ".env.local");

if (fs.existsSync(envPath)) {
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
