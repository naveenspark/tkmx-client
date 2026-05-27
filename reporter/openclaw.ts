import { readdir } from "node:fs/promises";
import type { DailyUsage } from "./usage.js";

export interface CollectOpenclawUsageOpts {
  sinceDateStr: string;
  /** Each entry is a sessions dir (e.g. `<root>/agents/main/sessions`). All are scanned and aggregated together. */
  sessionsDirs: string[];
}

export async function collectOpenclawUsage(
  opts: CollectOpenclawUsageOpts,
): Promise<DailyUsage[]> {
  if (opts.sessionsDirs.length === 0) return [];
  let anySessionFiles = false;
  for (const dir of opts.sessionsDirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (
      entries.some(
        (n) =>
          n.endsWith(".jsonl") &&
          !n.endsWith(".trajectory.jsonl") &&
          n !== "sessions.json",
      )
    ) {
      anySessionFiles = true;
      break;
    }
  }
  if (!anySessionFiles) return [];
  return []; // full pipeline added in Task 4
}
