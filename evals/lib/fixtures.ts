/**
 * Load every *.json fixture in evals/fixtures/<dir> - the golden set an eval
 * file runs against. Each fixture is expected to carry its own `id`; when
 * one doesn't, the filename (minus .json) is used, so a fixture is always
 * identifiable in the report even if someone forgot the field.
 */

import fs from "node:fs";
import path from "node:path";

const FIXTURES_ROOT = path.join(import.meta.dirname, "..", "fixtures");

export function loadFixtures<T extends { id?: string }>(dir: string): (T & { id: string })[] {
  const full = path.join(FIXTURES_ROOT, dir);
  const files = fs.readdirSync(full).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(full, file), "utf8")) as T;
    return { ...raw, id: raw.id ?? file.replace(/\.json$/, "") };
  });
}
