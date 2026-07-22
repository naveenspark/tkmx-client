import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as readline from "node:readline";
import type { DailyUsage } from "./usage";
import { mergeDailyUsage } from "./merge";

// Grok Build (grok CLI) persists per-turn token usage ONLY in each session's
// updates.jsonl event log — agentsview's grok provider is deliberately
// metadata-first and never parses updates.jsonl, so (unlike claude/codex)
// grok usage can't come from `agentsview usage daily`. We read the logs
// directly, mirroring reporter/openclaw.ts.
//
// Wire shape (one line per event):
//   { "timestamp": <unix seconds>,
//     "params": { "sessionId": "...", "update": {
//       "sessionUpdate": "turn_completed", "prompt_id": "...",
//       "usage": { ..., "modelUsage": { "<model>": {
//         "inputTokens": N, "outputTokens": N, "cachedReadTokens": N } } } } } }
//
// Semantics verified against real session data:
// - usage is per-turn (not cumulative); (sessionId, prompt_id) is unique.
// - inputTokens INCLUDES cachedReadTokens — subtract so counters stay
//   disjoint like every other producer (claude/codex report net input).
// - reasoningTokens ⊆ outputTokens (wire totalTokens = input + output).
// - there is no cache-write counter; cacheCreationTokens is always 0.
// - costUsdTicks is absent on most records, so cost is omitted and the
//   server estimates it from the model name like other sources.

interface GrokUsageRecord {
  date: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  dedupKey: string;
}

const GROK_SOURCE = "grok";

function toLocalIsoDate(unixSeconds: number): string | null {
  const d = new Date(unixSeconds * 1000);
  if (isNaN(d.getTime())) return null;
  // Local calendar date (mirrors reporter/openclaw.ts:toIsoDate) so grok rows
  // bucket on the same day as claude/codex rows.
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

export function parseUpdateLine(line: string): GrokUsageRecord[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const update = obj?.params?.update;
  if (update?.sessionUpdate !== "turn_completed") return [];
  const modelUsage = update.usage?.modelUsage;
  const sessionId = obj.params.sessionId;
  const promptId = update.prompt_id;
  // No modelUsage / ids → no way to attribute or dedupe; skip the record.
  if (!modelUsage || !sessionId || !promptId) return [];
  const date = toLocalIsoDate(Number(obj.timestamp));
  if (!date) return [];
  const records: GrokUsageRecord[] = [];
  for (const [modelName, mu] of Object.entries<Record<string, unknown>>(modelUsage)) {
    const grossInput = Number((mu as { inputTokens?: number }).inputTokens ?? 0);
    const outputTokens = Number((mu as { outputTokens?: number }).outputTokens ?? 0);
    const cacheReadTokens = Number((mu as { cachedReadTokens?: number }).cachedReadTokens ?? 0);
    const inputTokens = Math.max(0, grossInput - cacheReadTokens);
    records.push({
      date,
      modelName,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      totalTokens: inputTokens + outputTokens + cacheReadTokens,
      dedupKey: `${sessionId}|${promptId}|${modelName}`,
    });
  }
  return records;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

interface DiscoverOpts {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

export async function discoverGrokSessionsDirs(opts: DiscoverOpts): Promise<string[]> {
  const override = opts.env.GROK_SESSIONS_DIRS;
  if (override && override.trim().length > 0) {
    return override.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const dir = `${opts.homeDir}/.grok/sessions`;
  return (await exists(dir)) ? [dir] : [];
}

export function aggregateRecords(records: GrokUsageRecord[]): DailyUsage[] {
  // Dedupe by (sessionId, prompt_id, model), then let mergeDailyUsage do the
  // (date, modelName, source) summing it already owns for every other source.
  const seen = new Set<string>();
  const rows: DailyUsage[] = [];
  for (const rec of records) {
    if (seen.has(rec.dedupKey)) continue;
    seen.add(rec.dedupKey);
    rows.push({
      date: rec.date,
      modelBreakdowns: [{
        modelName: rec.modelName,
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        cacheCreationTokens: rec.cacheCreationTokens,
        cacheReadTokens: rec.cacheReadTokens,
        totalTokens: rec.totalTokens,
        source: GROK_SOURCE,
      }],
    });
  }
  return mergeDailyUsage(rows);
}

// Session layout: <sessionsDir>/<url-encoded-cwd>/<session-uuid>/updates.jsonl.
// updates.jsonl also logs every tool-call/thought chunk, so files reach
// hundreds of MB — stream line-by-line with a cheap substring guard instead
// of openclaw's whole-file readFile, and skip files whose mtime predates the
// window (every record in a file is older than the file's last write).
async function parseUpdatesFile(file: string, sinceIso: string, out: GrokUsageRecord[]): Promise<void> {
  const rl = readline.createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"turn_completed"')) continue;
    for (const r of parseUpdateLine(line)) {
      if (r.date >= sinceIso) out.push(r);
    }
  }
}

interface CollectGrokUsageOpts {
  sinceDateStr: string;
  /** Each entry is a grok sessions root (e.g. `~/.grok/sessions`). All are scanned and aggregated together. */
  sessionsDirs: string[];
}

export async function collectGrokUsage(opts: CollectGrokUsageOpts): Promise<DailyUsage[]> {
  if (opts.sessionsDirs.length === 0) return [];
  // sinceDateStr is YYYYMMDD (formatSinceStr in window.ts); records carry
  // YYYY-MM-DD, so convert before comparing (same contract as openclaw.ts).
  const sinceIso = `${opts.sinceDateStr.slice(0, 4)}-${opts.sinceDateStr.slice(4, 6)}-${opts.sinceDateStr.slice(6, 8)}`;
  const records: GrokUsageRecord[] = [];
  for (const root of opts.sessionsDirs) {
    // Fail loud on ENOENT — discoverGrokSessionsDirs already filtered to
    // dirs that exist, so a miss here is a typo'd GROK_SESSIONS_DIRS or a
    // real FS issue; silent skip would silently undercount.
    const projectDirs = await readdir(root, { withFileTypes: true });
    for (const proj of projectDirs) {
      if (!proj.isDirectory()) continue;
      const projPath = `${root}/${proj.name}`;
      const sessionDirs = await readdir(projPath, { withFileTypes: true });
      for (const sess of sessionDirs) {
        if (!sess.isDirectory()) continue;
        const file = `${projPath}/${sess.name}/updates.jsonl`;
        let st;
        try { st = await stat(file); } catch { continue; }
        // mtime gate: every record's timestamp ≤ the file's last write, so a
        // file untouched since before the window has nothing in-window.
        if ((toLocalIsoDate(st.mtimeMs / 1000) ?? "") < sinceIso) continue;
        await parseUpdatesFile(file, sinceIso, records);
      }
    }
  }
  return aggregateRecords(records);
}
