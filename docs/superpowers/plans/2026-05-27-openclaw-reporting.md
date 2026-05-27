# OpenClaw Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenClaw token usage as a portable tkmx-client reporting source — works for users who run OpenClaw standalone, wrapped by Plow, wrapped by Plow dev/wt variants, or wrapped by any future host that follows OpenClaw's session-dir convention.

**Architecture:** New `reporter/openclaw.ts` collector that (a) discovers OpenClaw session directories by globbing a known set of install roots — standalone `~/.openclaw/`, plow `~/Library/Application Support/co.plow.app*/openclaw/gateway/`, dev variants — and an env-var override `OPENCLAW_SESSIONS_DIRS` (comma-separated, same convention as `EXTRA_CLAUDE_CONFIGS`); (b) under each root, reads every `<root>/agents/main/sessions/*.jsonl`, parses `message.role == "assistant"` lines for the `usage` blob, dedupes by `responseId`, aggregates to `DailyUsage[]` tagged `source: "openclaw"`. Hardcoded 5th call site in `report.ts` (consistent with existing collectors — no plugin registry).

**Portability stance:** The source is the **agent** (OpenClaw), not the **host** (Plow). The reporter must not assume Plow is installed; it must not hardcode one OS's path; it must not silently lose data from a user who runs OpenClaw under a non-default install. Discovery is glob-based so new Plow variants and a future standalone OpenClaw install both work without code changes. When Hermes ships (as a sibling agent slot inside the same hosts), a sibling collector will tag `source: "hermes"`; this plan does not pre-build that.

**Tech Stack:** TypeScript (strict), Node.js built-in `fs/promises`, `node:test` runner, existing `DailyUsage` schema (`reporter/usage.ts:23-26`), existing merge/dedup contract (`reporter/merge.ts:17`).

**Server coordination:** None blocking. Server merges on `(modelName, source)` per `reporter/merge.ts:17` — any new source string is accepted. Profile-page display labels for "openclaw" can be added server-side independently.

**Verified discovery roots on the author's mac (for fixture-free smoke-test sanity):**
- Standalone `~/.openclaw/` — **absent** (this user runs OpenClaw via Plow only)
- `~/Library/Application Support/co.plow.app/openclaw/gateway/agents/main/sessions/` — **present, 1,574 files**
- `~/Library/Application Support/co.plow.app.{wt1,dev,dev.test,dev.wt1,dev.wt1.test}/openclaw/...` — multiple variants present

**Out of scope (defer until rule-of-3):**
- Cost computation from `usage.cost` (always zero in observed files; server computes from tokens + model).
- Hermes support (no data exists yet).
- Multi-agent-slot scanning (`agents/*/sessions` — today only `agents/main/` exists; Hermes will arrive as `agents/hermes/` and a sibling collector handles it then).

---

## File Structure

**New files:**
- `reporter/openclaw.ts` — discovery + collector
- `test/openclaw.test.ts` — unit tests for parsing, dedup, aggregation, discovery, error paths
- `test/fixtures/openclaw/` — fixture tree with multiple "roots" to exercise multi-root discovery

**Modified files:**
- `reporter/report.ts` — add import + call site after the OpenAI collector
- `test/report-e2e.test.ts` — extend the e2e harness to set `OPENCLAW_SESSIONS_DIRS` env and assert openclaw rows in POST
- `test/report-wiring.test.ts` — extend the source-grep guard to assert `collectOpenclawUsage` uses `sinceStr` (token window), not `statsSinceStr`
- `README.md` — document `OPENCLAW_SESSIONS_DIRS` env var and the discovery defaults

**No changes:**
- `reporter/merge.ts` — variadic / source-keyed already
- `reporter/usage.ts` — `DailyUsage` shape unchanged (may need to add `export` to `ModelBreakdown` if not already)
- `reporter/install.ts` — no install change

---

## Task 1: Branch + skeleton collector with discovery signature

**Files:**
- Create: `reporter/openclaw.ts`
- Create: `test/openclaw.test.ts`
- Create: `test/fixtures/openclaw/empty-root/.gitkeep`

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/samuelodio/Hacking/tkmx-client7
git checkout main
git pull
git checkout -b feat/openclaw-reporting
```

- [ ] **Step 2: Create an empty-root fixture (for the "no sessions anywhere" path)**

```bash
mkdir -p test/fixtures/openclaw/empty-root
touch test/fixtures/openclaw/empty-root/.gitkeep
```

- [ ] **Step 3: Write the failing skeleton tests**

Create `test/openclaw.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectOpenclawUsage } from "../reporter/openclaw.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, "fixtures", "openclaw");

test("collectOpenclawUsage returns [] when given zero roots", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "2026-05-01",
    sessionsDirs: [],
  });
  assert.deepEqual(result, []);
});

test("collectOpenclawUsage returns [] when every root is missing on disk", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "2026-05-01",
    sessionsDirs: [
      path.join(FIXTURES, "does-not-exist-1"),
      path.join(FIXTURES, "does-not-exist-2"),
    ],
  });
  assert.deepEqual(result, []);
});

test("collectOpenclawUsage returns [] when roots exist but contain no .jsonl session files", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "2026-05-01",
    sessionsDirs: [path.join(FIXTURES, "empty-root")],
  });
  assert.deepEqual(result, []);
});
```

- [ ] **Step 4: Create the collector skeleton that throws**

Create `reporter/openclaw.ts`:

```typescript
import type { DailyUsage } from "./usage.js";

export interface CollectOpenclawUsageOpts {
  sinceDateStr: string;
  /** Each entry is a sessions dir (e.g. `<root>/agents/main/sessions`). All are scanned and aggregated together. */
  sessionsDirs: string[];
}

export async function collectOpenclawUsage(
  _opts: CollectOpenclawUsageOpts,
): Promise<DailyUsage[]> {
  throw new Error("not implemented");
}
```

- [ ] **Step 5: Run tests to verify they fail**

```bash
just test 2>&1 | grep -E "openclaw|fail" | head -20
```

Expected: 3 failures, all `Error: not implemented`.

- [ ] **Step 6: Implement the no-data fast paths**

Replace the body of `collectOpenclawUsage`:

```typescript
import { readdir } from "node:fs/promises";

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
    if (entries.some((n) => n.endsWith(".jsonl") && !n.endsWith(".trajectory.jsonl") && n !== "sessions.json")) {
      anySessionFiles = true;
      break;
    }
  }
  if (!anySessionFiles) return [];
  return []; // full pipeline added in Task 4
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
just test 2>&1 | grep -E "openclaw|pass|fail" | head -10
```

Expected: 3 new tests pass; full suite green.

- [ ] **Step 8: Commit**

```bash
git add reporter/openclaw.ts test/openclaw.test.ts test/fixtures/openclaw/empty-root/.gitkeep
git commit -m "feat(openclaw): collector skeleton accepting multiple sessions dirs"
```

---

## Task 2: parseUsageLine — one assistant message → one usage record

**Files:**
- Modify: `reporter/openclaw.ts`
- Modify: `test/openclaw.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/openclaw.test.ts`:

```typescript
import { parseUsageLine } from "../reporter/openclaw.js";

test("parseUsageLine extracts usage from an assistant message", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-05-25T19:19:55.663Z",
    message: {
      role: "assistant",
      model: "anthropic/claude-sonnet-4-6",
      provider: "plow",
      api: "openai-completions",
      usage: { input: 31593, output: 147, cacheRead: 100, cacheWrite: 50, totalTokens: 31790 },
      responseId: "chatcmpl-369386b2",
    },
  });
  assert.deepEqual(parseUsageLine(line), {
    date: "2026-05-25",
    modelName: "anthropic/claude-sonnet-4-6",
    inputTokens: 31593,
    outputTokens: 147,
    cacheReadTokens: 100,
    cacheCreationTokens: 50,
    totalTokens: 31790,
    responseId: "chatcmpl-369386b2",
  });
});

test("parseUsageLine returns null for non-message lines", () => {
  assert.equal(parseUsageLine(JSON.stringify({ type: "session", id: "abc" })), null);
});

test("parseUsageLine returns null for user messages", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-05-25T19:19:55.663Z",
    message: { role: "user", content: "hi" },
  });
  assert.equal(parseUsageLine(line), null);
});

test("parseUsageLine returns null for assistant messages without usage", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-05-25T19:19:55.663Z",
    message: { role: "assistant", model: "x", responseId: "r" },
  });
  assert.equal(parseUsageLine(line), null);
});

test("parseUsageLine returns null for assistant messages without responseId (cannot dedupe)", () => {
  const line = JSON.stringify({
    type: "message",
    timestamp: "2026-05-25T19:19:55.663Z",
    message: { role: "assistant", model: "x", usage: { input: 1, output: 1, totalTokens: 2 } },
  });
  assert.equal(parseUsageLine(line), null);
});

test("parseUsageLine returns null for malformed JSON", () => {
  assert.equal(parseUsageLine("not json"), null);
});

test("parseUsageLine falls back to message.timestamp (epoch ms) when top-level timestamp missing", () => {
  const line = JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      model: "anthropic/claude-sonnet-4-6",
      timestamp: 1779736791413,
      usage: { input: 1, output: 1, totalTokens: 2 },
      responseId: "r1",
    },
  });
  assert.equal(parseUsageLine(line)?.date, "2026-05-25");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
just test 2>&1 | grep parseUsageLine | head -10
```

Expected: build error — `parseUsageLine` not exported.

- [ ] **Step 3: Implement `parseUsageLine`**

Add to `reporter/openclaw.ts` above `collectOpenclawUsage`:

```typescript
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
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
just test 2>&1 | tail -15
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add reporter/openclaw.ts test/openclaw.test.ts
git commit -m "feat(openclaw): parseUsageLine extracts assistant usage records"
```

---

## Task 3: aggregateRecords — DailyUsage[] with responseId dedup

**Files:**
- Modify: `reporter/openclaw.ts`
- Modify: `test/openclaw.test.ts`
- (Possibly) Modify: `reporter/usage.ts` — ensure `ModelBreakdown` is exported

- [ ] **Step 1: Write the failing tests**

Append to `test/openclaw.test.ts`:

```typescript
import { aggregateRecords } from "../reporter/openclaw.js";

const rec = (date: string, model: string, input: number, output: number, responseId: string) => ({
  date, modelName: model, inputTokens: input, outputTokens: output,
  cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: input + output, responseId,
});

test("aggregateRecords sums tokens by (date, model) and tags source=openclaw", () => {
  const result = aggregateRecords([
    rec("2026-05-25", "anthropic/claude-sonnet-4-6", 100, 10, "r1"),
    rec("2026-05-25", "anthropic/claude-sonnet-4-6", 200, 20, "r2"),
    rec("2026-05-25", "anthropic/claude-opus-4-7", 50, 5, "r3"),
    rec("2026-05-26", "anthropic/claude-sonnet-4-6", 10, 1, "r4"),
  ]);
  assert.equal(result.length, 2);
  const day25 = result.find((d) => d.date === "2026-05-25")!;
  assert.equal(day25.modelBreakdowns.length, 2);
  const sonnet = day25.modelBreakdowns.find((m) => m.modelName === "anthropic/claude-sonnet-4-6")!;
  assert.equal(sonnet.inputTokens, 300);
  assert.equal(sonnet.outputTokens, 30);
  assert.equal(sonnet.totalTokens, 330);
  assert.equal(sonnet.source, "openclaw");
});

test("aggregateRecords dedupes records sharing the same responseId", () => {
  const r = rec("2026-05-25", "anthropic/claude-sonnet-4-6", 100, 10, "r1");
  const result = aggregateRecords([r, r, r]);
  assert.equal(result[0].modelBreakdowns[0].inputTokens, 100);
  assert.equal(result[0].modelBreakdowns[0].totalTokens, 110);
});

test("aggregateRecords returns rows sorted by date ascending", () => {
  const result = aggregateRecords([
    rec("2026-05-27", "m", 1, 1, "a"),
    rec("2026-05-25", "m", 1, 1, "b"),
    rec("2026-05-26", "m", 1, 1, "c"),
  ]);
  assert.deepEqual(result.map((r) => r.date), ["2026-05-25", "2026-05-26", "2026-05-27"]);
});
```

- [ ] **Step 2: Verify failure**

```bash
just test 2>&1 | grep aggregateRecords | head -5
```

Expected: build error.

- [ ] **Step 3: Implement `aggregateRecords` and ensure `ModelBreakdown` is exported**

If `reporter/usage.ts` does not already `export` the `ModelBreakdown` interface, add the `export` keyword to its declaration.

Add to `reporter/openclaw.ts`:

```typescript
import type { DailyUsage, ModelBreakdown } from "./usage.js";

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
```

- [ ] **Step 4: Verify pass**

```bash
just test 2>&1 | tail -15
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add reporter/openclaw.ts test/openclaw.test.ts reporter/usage.ts
git commit -m "feat(openclaw): aggregate records with responseId dedup"
```

---

## Task 4: End-to-end collector across multiple roots

**Files:**
- Modify: `reporter/openclaw.ts`
- Modify: `test/openclaw.test.ts`
- Create: `test/fixtures/openclaw/root-a/abc.jsonl`
- Create: `test/fixtures/openclaw/root-a/def.checkpoint.cp1.jsonl`
- Create: `test/fixtures/openclaw/root-a/abc.trajectory.jsonl`
- Create: `test/fixtures/openclaw/root-a/sessions.json`
- Create: `test/fixtures/openclaw/root-b/ghi.jsonl`

The multi-root fixture proves that two install roots (e.g. plow prod + plow wt1) get aggregated together and deduped by responseId across roots — protecting users who move sessions between installs or run parallel Plow variants pointing at the same OpenClaw data.

- [ ] **Step 1: Create fixture files**

`test/fixtures/openclaw/root-a/abc.jsonl`:

```jsonl
{"type":"session","id":"abc","timestamp":"2026-05-25T10:00:00.000Z"}
{"type":"message","timestamp":"2026-05-25T10:00:05.000Z","message":{"role":"user","content":"hi"}}
{"type":"message","timestamp":"2026-05-25T10:00:10.000Z","message":{"role":"assistant","model":"anthropic/claude-sonnet-4-6","usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110},"responseId":"resp-abc-1"}}
```

`test/fixtures/openclaw/root-a/def.checkpoint.cp1.jsonl` (checkpoint of abc — duplicates resp-abc-1, adds resp-def-1):

```jsonl
{"type":"message","timestamp":"2026-05-25T10:00:10.000Z","message":{"role":"assistant","model":"anthropic/claude-sonnet-4-6","usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110},"responseId":"resp-abc-1"}}
{"type":"message","timestamp":"2026-05-25T11:00:00.000Z","message":{"role":"assistant","model":"anthropic/claude-sonnet-4-6","usage":{"input":50,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":55},"responseId":"resp-def-1"}}
```

`test/fixtures/openclaw/root-a/abc.trajectory.jsonl` (must be ignored — otherwise re-adds resp-abc-1):

```jsonl
{"type":"message","timestamp":"2026-05-25T10:00:10.000Z","message":{"role":"assistant","model":"anthropic/claude-sonnet-4-6","usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110},"responseId":"resp-abc-1"}}
```

`test/fixtures/openclaw/root-a/sessions.json` (must be ignored):

```json
{"agent:main:main":{"sessionId":"abc"}}
```

`test/fixtures/openclaw/root-b/ghi.jsonl` (different root, different model, different day, plus a cross-root duplicate of resp-abc-1):

```jsonl
{"type":"message","timestamp":"2026-05-25T10:00:10.000Z","message":{"role":"assistant","model":"anthropic/claude-sonnet-4-6","usage":{"input":100,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":110},"responseId":"resp-abc-1"}}
{"type":"message","timestamp":"2026-05-26T09:00:00.000Z","message":{"role":"assistant","model":"anthropic/claude-opus-4-7","usage":{"input":200,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":220},"responseId":"resp-ghi-1"}}
```

`package.json`'s `build:tests` script already does `cp -R test/fixtures dist/test/fixtures`, so no build change is needed.

- [ ] **Step 2: Write the failing end-to-end tests**

Append to `test/openclaw.test.ts`:

```typescript
test("collectOpenclawUsage aggregates across multiple roots, dedupes by responseId across roots, ignores trajectory + sessions.json", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "2026-05-01",
    sessionsDirs: [
      path.join(FIXTURES, "root-a"),
      path.join(FIXTURES, "root-b"),
    ],
  });
  assert.equal(result.length, 2);
  const day25 = result.find((d) => d.date === "2026-05-25")!;
  const sonnet = day25.modelBreakdowns.find((m) => m.modelName === "anthropic/claude-sonnet-4-6")!;
  // resp-abc-1 appears in 3 places (root-a/abc, root-a/def.checkpoint, root-b/ghi) — counted once.
  // resp-def-1 (only in root-a) — counted once.
  assert.equal(sonnet.inputTokens, 150);
  assert.equal(sonnet.outputTokens, 15);
  assert.equal(sonnet.totalTokens, 165);
  assert.equal(sonnet.source, "openclaw");
  const day26 = result.find((d) => d.date === "2026-05-26")!;
  assert.equal(day26.modelBreakdowns[0].modelName, "anthropic/claude-opus-4-7");
  assert.equal(day26.modelBreakdowns[0].totalTokens, 220);
});

test("collectOpenclawUsage filters out days strictly before sinceDateStr", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "2026-05-26",
    sessionsDirs: [
      path.join(FIXTURES, "root-a"),
      path.join(FIXTURES, "root-b"),
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].date, "2026-05-26");
});

test("collectOpenclawUsage skips a missing root in a list of roots without failing", async () => {
  const result = await collectOpenclawUsage({
    sinceDateStr: "2026-05-01",
    sessionsDirs: [
      path.join(FIXTURES, "does-not-exist"),
      path.join(FIXTURES, "root-b"),
    ],
  });
  // root-b alone: only resp-abc-1 (dedupes itself) and resp-ghi-1
  assert.equal(result.length, 2);
});
```

- [ ] **Step 3: Verify failure**

```bash
just test 2>&1 | grep -E "aggregates across multiple|filters out days|skips a missing" | head -5
```

Expected: failures (skeleton still returns `[]`).

- [ ] **Step 4: Implement the full pipeline**

Replace the body of `collectOpenclawUsage`:

```typescript
import { readFile, readdir } from "node:fs/promises";

export async function collectOpenclawUsage(
  opts: CollectOpenclawUsageOpts,
): Promise<DailyUsage[]> {
  if (opts.sessionsDirs.length === 0) return [];
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
      try { contents = await readFile(`${dir}/${name}`, "utf8"); } catch { continue; }
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        const r = parseUsageLine(line);
        if (r && r.date >= opts.sinceDateStr) records.push(r);
      }
    }
  }
  return aggregateRecords(records);
}
```

- [ ] **Step 5: Verify pass**

```bash
just test 2>&1 | tail -15
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add reporter/openclaw.ts test/openclaw.test.ts test/fixtures/openclaw/
git commit -m "feat(openclaw): scan multiple roots, dedupe by responseId across roots"
```

---

## Task 5: discoverOpenclawSessionsDirs — portable multi-root discovery

**Files:**
- Modify: `reporter/openclaw.ts`
- Modify: `test/openclaw.test.ts`
- Create: `test/fixtures/openclaw/discovery/home/.openclaw/agents/main/sessions/.gitkeep`
- Create: `test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app/openclaw/gateway/agents/main/sessions/.gitkeep`
- Create: `test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app.dev.wt1/openclaw/gateway/agents/main/sessions/.gitkeep`
- Create: `test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app.wt1/openclaw/gateway/agents/main/sessions/.gitkeep`
- Create: `test/fixtures/openclaw/discovery/home/Library/Application Support/unrelated/.gitkeep`

The discovery fixture mirrors a real user's `~` so the function can be tested without poking the real home dir. Each `.gitkeep` is a stand-in for "this directory exists"; the discovery function only checks for existence, not content.

- [ ] **Step 1: Create the discovery fixture tree**

```bash
mkdir -p "test/fixtures/openclaw/discovery/home/.openclaw/agents/main/sessions"
touch "test/fixtures/openclaw/discovery/home/.openclaw/agents/main/sessions/.gitkeep"
mkdir -p "test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app/openclaw/gateway/agents/main/sessions"
touch "test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app/openclaw/gateway/agents/main/sessions/.gitkeep"
mkdir -p "test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app.dev.wt1/openclaw/gateway/agents/main/sessions"
touch "test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app.dev.wt1/openclaw/gateway/agents/main/sessions/.gitkeep"
mkdir -p "test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app.wt1/openclaw/gateway/agents/main/sessions"
touch "test/fixtures/openclaw/discovery/home/Library/Application Support/co.plow.app.wt1/openclaw/gateway/agents/main/sessions/.gitkeep"
mkdir -p "test/fixtures/openclaw/discovery/home/Library/Application Support/unrelated"
touch "test/fixtures/openclaw/discovery/home/Library/Application Support/unrelated/.gitkeep"
```

- [ ] **Step 2: Write the failing tests**

Append to `test/openclaw.test.ts`:

```typescript
import { discoverOpenclawSessionsDirs } from "../reporter/openclaw.js";

const DISCOVERY_HOME = path.join(FIXTURES, "discovery", "home");

test("discoverOpenclawSessionsDirs returns standalone + every plow variant on macOS", async () => {
  const result = await discoverOpenclawSessionsDirs({ env: {}, homeDir: DISCOVERY_HOME, platform: "darwin" });
  const rel = result.map((p) => p.slice(DISCOVERY_HOME.length + 1)).sort();
  assert.deepEqual(rel, [
    ".openclaw/agents/main/sessions",
    "Library/Application Support/co.plow.app.dev.wt1/openclaw/gateway/agents/main/sessions",
    "Library/Application Support/co.plow.app.wt1/openclaw/gateway/agents/main/sessions",
    "Library/Application Support/co.plow.app/openclaw/gateway/agents/main/sessions",
  ].sort());
});

test("discoverOpenclawSessionsDirs returns only roots that exist (skips missing)", async () => {
  // Use a fresh empty home — nothing under it should be discovered.
  const emptyHome = path.join(FIXTURES, "empty-root");
  const result = await discoverOpenclawSessionsDirs({ env: {}, homeDir: emptyHome, platform: "darwin" });
  assert.deepEqual(result, []);
});

test("discoverOpenclawSessionsDirs honors OPENCLAW_SESSIONS_DIRS env (comma-separated, overrides probe)", async () => {
  const override = "/tmp/foo,/tmp/bar";
  const result = await discoverOpenclawSessionsDirs({
    env: { OPENCLAW_SESSIONS_DIRS: override },
    homeDir: DISCOVERY_HOME,
    platform: "darwin",
  });
  assert.deepEqual(result, ["/tmp/foo", "/tmp/bar"]);
});

test("discoverOpenclawSessionsDirs trims whitespace and ignores empty entries in env override", async () => {
  const result = await discoverOpenclawSessionsDirs({
    env: { OPENCLAW_SESSIONS_DIRS: "  /tmp/a , ,/tmp/b  ," },
    homeDir: DISCOVERY_HOME,
    platform: "darwin",
  });
  assert.deepEqual(result, ["/tmp/a", "/tmp/b"]);
});

test("discoverOpenclawSessionsDirs returns just standalone path on non-darwin platforms", async () => {
  const result = await discoverOpenclawSessionsDirs({ env: {}, homeDir: DISCOVERY_HOME, platform: "linux" });
  assert.deepEqual(result, [path.join(DISCOVERY_HOME, ".openclaw/agents/main/sessions")]);
});
```

- [ ] **Step 3: Verify failure**

```bash
just test 2>&1 | grep discoverOpenclawSessionsDirs | head -5
```

Expected: build error.

- [ ] **Step 4: Implement discovery**

Add to `reporter/openclaw.ts`:

```typescript
import { stat } from "node:fs/promises";

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
  // Linux app-support path can be added when an OpenClaw user actually exists on Linux.
  // Until then, only the standalone path is probed — consistent with file-taxonomy.md (c).
  const present: string[] = [];
  for (const c of candidates) {
    if (await exists(c)) present.push(c);
  }
  return present;
}
```

- [ ] **Step 5: Verify pass**

```bash
just test 2>&1 | tail -20
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add reporter/openclaw.ts test/openclaw.test.ts test/fixtures/openclaw/discovery/
git commit -m "feat(openclaw): portable multi-root discovery (standalone + glob plow variants + env override)"
```

---

## Task 6: Wire into report.ts

**Files:**
- Modify: `reporter/report.ts`

- [ ] **Step 1: Read the current report.ts around the OpenAI call site and the import block**

```bash
sed -n '1,40p;255,290p' reporter/report.ts
```

Note: exact import-block style, line right after `openaiDaily` is awaited, and the `mergeDailyUsage` call site.

- [ ] **Step 2: Add the import**

Add to the import block at the top of `reporter/report.ts`:

```typescript
import { collectOpenclawUsage, discoverOpenclawSessionsDirs } from "./openclaw.js";
```

If `os` is not already imported, also add: `import os from "node:os";`

- [ ] **Step 3: Discover roots and run the collector, then merge**

Immediately after the OpenAI collector block (search for `openaiDaily`), add:

```typescript
const openclawDirs = await discoverOpenclawSessionsDirs({
  env: process.env,
  homeDir: os.homedir(),
  platform: process.platform,
});
const openclawDaily = await collectOpenclawUsage({
  sinceDateStr: sinceStr,
  sessionsDirs: openclawDirs,
});
if (openclawDirs.length > 0) {
  console.log(`  OpenClaw: ${openclawDaily.length} days from ${openclawDirs.length} root(s)`);
}
```

Update the `mergeDailyUsage(...)` call to include `openclawDaily` as an additional argument.

- [ ] **Step 4: Run the full suite**

```bash
just test
```

Expected: full suite green.

- [ ] **Step 5: Smoke test against real data**

```bash
npm run build && node dist/reporter/report.js 2>&1 | grep -E "OpenClaw|Server responded" | head -10
```

Expected:
- `OpenClaw: N days from M root(s)` (M ≥ 1 on the author's mac — should pick up multiple plow variants from `co.plow.app*`)
- `Server responded 200`

If the server rejects the new source value or rows drop unexpectedly, stop and inspect the response.

- [ ] **Step 6: Commit**

```bash
git add reporter/report.ts
git commit -m "feat(openclaw): wire collector into report.ts pipeline"
```

---

## Task 7: e2e test in report-e2e.test.ts

**Files:**
- Modify: `test/report-e2e.test.ts`

- [ ] **Step 1: Read the existing e2e harness**

```bash
sed -n '1,80p' test/report-e2e.test.ts
```

Identify how it sets env vars and captures the POST body. Mirror the existing fixture/stub pattern.

- [ ] **Step 2: Write the failing e2e test**

Add to `test/report-e2e.test.ts` (use whatever the existing harness function is named — read first, then pattern-match):

```typescript
test("e2e: openclaw rows are present in POST body when OPENCLAW_SESSIONS_DIRS points at a fixture", async () => {
  const { posted } = await runReporterE2E({
    env: {
      OPENCLAW_SESSIONS_DIRS: [
        path.join(__dirname, "fixtures", "openclaw", "root-a"),
        path.join(__dirname, "fixtures", "openclaw", "root-b"),
      ].join(","),
      REPORT_DAYS: "60",
    },
  });
  const openclawRows = posted.data.flatMap((d: any) =>
    d.modelBreakdowns.filter((m: any) => m.source === "openclaw"),
  );
  assert.ok(openclawRows.length > 0, "expected openclaw rows in POST body");
  const sonnet = openclawRows.find((m: any) => m.modelName === "anthropic/claude-sonnet-4-6");
  assert.ok(sonnet, "expected anthropic/claude-sonnet-4-6 row from fixture");
});
```

If the harness doesn't accept an arbitrary env map, extend it with a small env passthrough — mirror whatever the OpenAI/Cursor tests do.

- [ ] **Step 3: Verify pass**

```bash
just test 2>&1 | grep -E "openclaw|e2e" | head -10
```

- [ ] **Step 4: Commit**

```bash
git add test/report-e2e.test.ts
git commit -m "test(openclaw): e2e — openclaw rows appear in POST body via env override"
```

---

## Task 8: Wiring-grep guard in report-wiring.test.ts

**Files:**
- Modify: `test/report-wiring.test.ts`

- [ ] **Step 1: Read the existing guards**

```bash
cat test/report-wiring.test.ts
```

- [ ] **Step 2: Add a guard ensuring openclaw uses sinceStr (token window) not statsSinceStr (28d)**

```typescript
test("collectOpenclawUsage is called with sinceStr, not statsSinceStr", () => {
  const src = readFileSync(path.join(__dirname, "..", "reporter", "report.ts"), "utf8");
  assert.match(
    src,
    /collectOpenclawUsage\(\s*\{[^}]*sinceDateStr:\s*sinceStr/,
    "openclaw must use REPORT_DAYS window (sinceStr), not the 28d stats window",
  );
});
```

- [ ] **Step 3: Verify pass**

```bash
just test 2>&1 | grep -E "wiring|openclaw" | head -10
```

- [ ] **Step 4: Commit**

```bash
git add test/report-wiring.test.ts
git commit -m "test(openclaw): wiring-grep guard for REPORT_DAYS window"
```

---

## Task 9: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find where env vars and sources are documented**

```bash
grep -n "OPENAI_ADMIN_KEY\|REPORT_DAYS\|EXTRA_CLAUDE_CONFIGS" README.md
```

- [ ] **Step 2: Document the OpenClaw source — agent-first framing**

In the sources section, add:

```markdown
- **OpenClaw** (`source: openclaw`) — token usage from the [OpenClaw](https://github.com/...) agent, read from local session JSONL transcripts. Auto-discovered on macOS at: `~/.openclaw/agents/main/sessions/` (standalone install) and `~/Library/Application Support/co.plow.app*/openclaw/gateway/agents/main/sessions/` (every Plow variant — production, dev, worktree clones). Silently skipped if no root exists. Other host wrappers can point the reporter at custom paths via `OPENCLAW_SESSIONS_DIRS` below.
```

In the env-vars section:

```markdown
- `OPENCLAW_SESSIONS_DIRS` (optional, comma-separated) — override the auto-discovered OpenClaw sessions directories. Each entry is one `<root>/agents/main/sessions/`. When set, replaces the probe entirely. Use this if OpenClaw is installed in a non-default location or if you want to scope reporting to a subset of installs.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(openclaw): document agent-first source and OPENCLAW_SESSIONS_DIRS"
```

---

## Task 10: Push, open PR, hand off to babysit-pr

**Files:** none

- [ ] **Step 1: Verify clean state and full suite**

```bash
git status
just test
```

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/openclaw-reporting
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(reporter): add OpenClaw as a portable tkmx source" --body "$(cat <<'EOF'
## Summary
- Adds `reporter/openclaw.ts`: collector for OpenClaw session JSONL transcripts (assistant messages carry `usage` blobs).
- **Portable, agent-first design**: source is `openclaw` (the agent), not `plow` (one host). Auto-discovers standalone OpenClaw + every Plow variant (`co.plow.app`, `.dev`, `.wt1`, `.dev.wt1`, …) by glob; users can override via `OPENCLAW_SESSIONS_DIRS` (comma-separated, mirrors `EXTRA_CLAUDE_CONFIGS`).
- Dedupes checkpoint forks by `responseId` across files AND across roots; ignores `*.trajectory.jsonl` and `sessions.json`.
- Hardcoded 5th call site in `report.ts` — consistent with existing collectors per `reporter/report.ts:265`. No plugin registry.

## Server coordination
None blocking — merge contract keys on `(modelName, source)` per `reporter/merge.ts:17`. Display labels for "openclaw" can land server-side independently.

## Test plan
- [x] Unit tests for `parseUsageLine`, `aggregateRecords`, `discoverOpenclawSessionsDirs` (including env override + non-darwin platforms)
- [x] Multi-root fixture e2e — cross-root `responseId` dedup, trajectory + sessions.json ignored
- [x] Wiring-grep guard for `sinceStr` (token window, not 28d stats window)
- [x] Smoke run on macOS picks up multiple Plow variants and POSTs `Server responded 200`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Immediately invoke `/babysit-pr <PR#>` on the same turn**

Per global rule. Do not ask first.

---

## Self-Review

**Spec coverage:**
- ✅ "Portable" — Task 5 does multi-root discovery (standalone + glob plow variants + env override), no hardcoded single path.
- ✅ "Don't want this shipping with plow" — source label is `openclaw` (agent), not `plow` (host); README framing puts OpenClaw first, lists plow paths as one example wrapper; the reporter is in tkmx-client (not in plow), reads (c) user state only.
- ✅ "Same as how tkmx-client works for claude, codex" — Task 6 mirrors the OpenAI call site; uses the existing `mergeDailyUsage` contract.
- ✅ Future-proofing — Hermes adds as a sibling collector when it has data; today's plan is YAGNI-tight.

**Placeholder scan:** None. Every step has actual code or actual commands.

**Type consistency:** `OpenclawUsageRecord`, `CollectOpenclawUsageOpts`, `DiscoverOpts`, `OPENCLAW_SOURCE` used consistently. `DailyUsage` and `ModelBreakdown` reused from `reporter/usage.ts` (Task 3 adds `export` if missing).

**Verified facts (don't re-litigate):**
- 6 plow wrapper roots present on the author's mac (`co.plow.app`, `.dev`, `.dev.test`, `.dev.wt1`, `.dev.wt1.test`, `.wt1`). Verified via `ls "Application Support" | grep plow`.
- `co.plow.app/openclaw/gateway/agents/main/sessions/` has 1,574 files. Verified via `ls | wc -l`.
- No `~/.openclaw/` on this machine — confirms importance of glob-based discovery (this user runs OpenClaw via Plow only).
- Sample assistant message has `obj.timestamp` (ISO) + `obj.message.timestamp` (epoch ms), `obj.message.usage.{input,output,cacheRead,cacheWrite,totalTokens}`, `obj.message.responseId` (unique per LLM call). Verified by reading a real message in `0017d1e4-…jsonl`.
- Server-side dedup keys on `(modelName, source)` per `reporter/merge.ts:17` — no server schema change required.
- Plow's `file-taxonomy.md` confirms `**/agents/*/sessions/*.jsonl` is `user-state` (c) — safe to read at user-process privilege.
