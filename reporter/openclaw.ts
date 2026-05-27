import { readdir } from "node:fs/promises";
import type { DailyUsage, ModelBreakdown } from "./usage";

export interface OpenclawUsageRecord {
  date: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  responseId: string;
}

function toIsoDate(input: string | number | undefined): string | null {
  if (input === undefined) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function parseUsageLine(line: string): OpenclawUsageRecord | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj?.type !== "message") return null;
  const msg = obj.message;
  if (msg?.role !== "assistant") return null;
  if (!msg.usage || !msg.model || !msg.responseId) return null;
  const date = toIsoDate(obj.timestamp) ?? toIsoDate(msg.timestamp);
  if (!date) return null;
  return {
    date,
    modelName: String(msg.model),
    inputTokens: Number(msg.usage.input ?? 0),
    outputTokens: Number(msg.usage.output ?? 0),
    cacheReadTokens: Number(msg.usage.cacheRead ?? 0),
    cacheCreationTokens: Number(msg.usage.cacheWrite ?? 0),
    totalTokens: Number(msg.usage.totalTokens ?? 0),
    responseId: String(msg.responseId),
  };
}

export const OPENCLAW_SOURCE = "openclaw";

export function aggregateRecords(records: OpenclawUsageRecord[]): DailyUsage[] {
  const seen = new Set<string>();
  const byDate = new Map<string, Map<string, ModelBreakdown>>();
  for (const rec of records) {
    if (seen.has(rec.responseId)) continue;
    seen.add(rec.responseId);
    let dayModels = byDate.get(rec.date);
    if (!dayModels) { dayModels = new Map(); byDate.set(rec.date, dayModels); }
    let mb = dayModels.get(rec.modelName);
    if (!mb) {
      mb = {
        modelName: rec.modelName, inputTokens: 0, outputTokens: 0,
        cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0,
        source: OPENCLAW_SOURCE,
      };
      dayModels.set(rec.modelName, mb);
    }
    mb.inputTokens += rec.inputTokens;
    mb.outputTokens += rec.outputTokens;
    mb.cacheReadTokens += rec.cacheReadTokens;
    mb.cacheCreationTokens += rec.cacheCreationTokens;
    mb.totalTokens += rec.totalTokens;
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, models]) => ({ date, modelBreakdowns: [...models.values()] }));
}

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
