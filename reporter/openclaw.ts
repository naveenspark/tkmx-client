import { readFile, readdir, stat } from "node:fs/promises";
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

const STANDALONE_REL = ".openclaw/agents/main/sessions";
const PLOW_REL_TAIL = "openclaw/gateway/agents/main/sessions";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export interface DiscoverOpts {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
}

export async function discoverOpenclawSessionsDirs(opts: DiscoverOpts): Promise<string[]> {
  const override = opts.env.OPENCLAW_SESSIONS_DIRS;
  if (override && override.trim().length > 0) {
    return override.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const candidates: string[] = [];
  candidates.push(`${opts.homeDir}/${STANDALONE_REL}`);
  if (opts.platform === "darwin") {
    const appSupport = `${opts.homeDir}/Library/Application Support`;
    let entries: string[] = [];
    try { entries = await readdir(appSupport); } catch { entries = []; }
    for (const name of entries) {
      // Match co.plow.app and any variant (co.plow.app.wt1, co.plow.app.dev, co.plow.app.dev.wt1, ...)
      if (name === "co.plow.app" || name.startsWith("co.plow.app.")) {
        candidates.push(`${appSupport}/${name}/${PLOW_REL_TAIL}`);
      }
    }
  }
  // Linux/Windows: standalone path only — Plow is macOS-only.
  const present: string[] = [];
  for (const c of candidates) {
    if (await exists(c)) present.push(c);
  }
  return present;
}

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
  // Normalize sinceDateStr to YYYY-MM-DD so the >= compare against r.date
  // works regardless of whether the caller passed YYYYMMDD (production —
  // formatSinceStr in window.ts) or YYYY-MM-DD (unit tests).
  const sinceIso =
    /^\d{8}$/.test(opts.sinceDateStr)
      ? `${opts.sinceDateStr.slice(0, 4)}-${opts.sinceDateStr.slice(4, 6)}-${opts.sinceDateStr.slice(6, 8)}`
      : opts.sinceDateStr;
  const records: OpenclawUsageRecord[] = [];
  for (const dir of opts.sessionsDirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const sessionFiles = entries.filter(
      (name) =>
        name.endsWith(".jsonl") &&
        !name.endsWith(".trajectory.jsonl") &&
        name !== "sessions.json",
    );
    for (const name of sessionFiles) {
      let contents: string;
      try {
        contents = await readFile(`${dir}/${name}`, "utf8");
      } catch {
        continue;
      }
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        const r = parseUsageLine(line);
        if (r && r.date >= sinceIso) records.push(r);
      }
    }
  }
  return aggregateRecords(records);
}
