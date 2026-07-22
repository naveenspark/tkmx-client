import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { collectGrokUsage, parseUpdateLine, aggregateRecords, discoverGrokSessionsDirs } from "../reporter/grok";

const FIXTURES = path.join(__dirname, "fixtures", "grok");

const turnLine = (
  ts: number,
  sessionId: string,
  promptId: string,
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cachedReadTokens: number }>,
) =>
  JSON.stringify({
    timestamp: ts,
    method: "_x.ai/session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn", usage: { modelUsage } },
    },
  });

test("collectGrokUsage returns [] when given zero roots", async () => {
  const result = await collectGrokUsage({ sinceDateStr: "20260501", sessionsDirs: [] });
  assert.deepEqual(result, []);
});

test("collectGrokUsage throws when a given root does not exist (fail-loud)", async () => {
  await assert.rejects(
    () => collectGrokUsage({ sinceDateStr: "20260501", sessionsDirs: [path.join(FIXTURES, "does-not-exist")] }),
    { code: "ENOENT" },
  );
});

test("collectGrokUsage returns [] when the root exists but holds no session dirs", async () => {
  const result = await collectGrokUsage({ sinceDateStr: "20260501", sessionsDirs: [path.join(FIXTURES, "empty-root")] });
  assert.deepEqual(result, []);
});

test("parseUpdateLine nets cached reads out of inputTokens and computes totalTokens", () => {
  // Grok's wire inputTokens INCLUDES cachedReadTokens; the record must carry
  // disjoint counters like every other producer (net input 1100-1000=100).
  const [rec] = parseUpdateLine(
    turnLine(1779735600, "sess-aaa", "p1", { "grok-4.5": { inputTokens: 1100, outputTokens: 10, cachedReadTokens: 1000 } }),
  );
  assert.deepEqual(rec, {
    date: "2026-05-25",
    modelName: "grok-4.5",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 1000,
    cacheCreationTokens: 0,
    totalTokens: 1110,
    dedupKey: "sess-aaa|p1|grok-4.5",
  });
});

test("parseUpdateLine clamps net input at 0 when cachedReadTokens exceeds inputTokens", () => {
  const [rec] = parseUpdateLine(
    turnLine(1779735600, "s", "p", { "grok-4.5": { inputTokens: 100, outputTokens: 1, cachedReadTokens: 150 } }),
  );
  assert.equal(rec.inputTokens, 0);
  assert.equal(rec.totalTokens, 151);
});

test("parseUpdateLine emits one record per model on multi-model turns", () => {
  const recs = parseUpdateLine(
    turnLine(1779735600, "s", "p", {
      "grok-4.5": { inputTokens: 200, outputTokens: 20, cachedReadTokens: 0 },
      "grok-4.5-build": { inputTokens: 50, outputTokens: 5, cachedReadTokens: 0 },
    }),
  );
  assert.deepEqual(recs.map((r) => [r.modelName, r.totalTokens, r.dedupKey]), [
    ["grok-4.5", 220, "s|p|grok-4.5"],
    ["grok-4.5-build", 55, "s|p|grok-4.5-build"],
  ]);
});

test("parseUpdateLine returns [] for non-turn_completed updates, missing modelUsage/ids, and malformed JSON", () => {
  assert.deepEqual(parseUpdateLine('{"timestamp":1,"params":{"sessionId":"s","update":{"sessionUpdate":"agent_thought_chunk"}}}'), []);
  assert.deepEqual(
    parseUpdateLine('{"timestamp":1,"params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p","usage":{"inputTokens":5}}}}'),
    [],
    "usage without modelUsage cannot be attributed to a model",
  );
  assert.deepEqual(
    parseUpdateLine(turnLine(1779735600, "", "p", { m: { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } })),
    [],
    "missing sessionId cannot be deduped",
  );
  assert.deepEqual(parseUpdateLine("not json"), []);
});

test("parseUpdateLine uses local calendar date (timestamp is unix seconds)", () => {
  // 2026-05-26T06:00Z = 23:00 PDT May 25 — must bucket with the same
  // moment's claude/codex rows (local dates), not the UTC date.
  const originalTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const [rec] = parseUpdateLine(
      turnLine(1779775200, "s", "p", { "grok-4.5": { inputTokens: 1, outputTokens: 1, cachedReadTokens: 0 } }),
    );
    assert.equal(rec.date, "2026-05-25", "expected local Pacific date 2026-05-25, not UTC 2026-05-26");
  } finally {
    process.env.TZ = originalTZ;
  }
});

const rec = (date: string, model: string, input: number, output: number, dedupKey: string) => ({
  date, modelName: model, inputTokens: input, outputTokens: output,
  cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: input + output, dedupKey,
});

test("aggregateRecords sums tokens by (date, model), dedupes by dedupKey, tags source=grok", () => {
  const dup = rec("2026-05-25", "grok-4.5", 100, 10, "s|p1|grok-4.5");
  const result = aggregateRecords([
    dup, dup,
    rec("2026-05-25", "grok-4.5", 200, 20, "s|p2|grok-4.5"),
    rec("2026-05-26", "grok-4.5", 10, 1, "s|p3|grok-4.5"),
  ]);
  assert.equal(result.length, 2);
  const day25 = result.find((d) => d.date === "2026-05-25")!;
  assert.equal(day25.modelBreakdowns.length, 1);
  assert.equal(day25.modelBreakdowns[0].inputTokens, 300);
  assert.equal(day25.modelBreakdowns[0].totalTokens, 330);
  assert.equal(day25.modelBreakdowns[0].source, "grok");
});

test("collectGrokUsage aggregates across roots, dedupes across roots, skips noise/non-dirs", async () => {
  const originalTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const result = await collectGrokUsage({
      sinceDateStr: "20260501",
      sessionsDirs: [path.join(FIXTURES, "root-a"), path.join(FIXTURES, "root-b")],
    });
    assert.deepEqual(result.map((r) => r.date), ["2026-05-24", "2026-05-25", "2026-05-26"]);
    const day25 = result.find((d) => d.date === "2026-05-25")!;
    const g45 = day25.modelBreakdowns.find((m) => m.modelName === "grok-4.5")!;
    // p1 (100/10/1000, duplicated in-file AND in root-b — counted once)
    // + p2 (200/20/0) + sess-bbb p2 (0/1/150, clamped)
    assert.equal(g45.inputTokens, 300);
    assert.equal(g45.outputTokens, 31);
    assert.equal(g45.cacheReadTokens, 1150);
    assert.equal(g45.totalTokens, 1481);
    assert.equal(g45.source, "grok");
    const build = day25.modelBreakdowns.find((m) => m.modelName === "grok-4.5-build")!;
    assert.equal(build.totalTokens, 55);
  } finally {
    process.env.TZ = originalTZ;
  }
});

test("collectGrokUsage filters out days strictly before sinceDateStr", async () => {
  const originalTZ = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const result = await collectGrokUsage({
      sinceDateStr: "20260525",
      sessionsDirs: [path.join(FIXTURES, "root-a")],
    });
    assert.deepEqual(result.map((r) => r.date), ["2026-05-25", "2026-05-26"]);
  } finally {
    process.env.TZ = originalTZ;
  }
});

const DISCOVERY_HOME = path.join(FIXTURES, "discovery", "home");

test("discoverGrokSessionsDirs returns ~/.grok/sessions when present", async () => {
  const result = await discoverGrokSessionsDirs({ env: {}, homeDir: DISCOVERY_HOME });
  assert.deepEqual(result, [path.join(DISCOVERY_HOME, ".grok/sessions")]);
});

test("discoverGrokSessionsDirs returns [] when ~/.grok/sessions is absent", async () => {
  const result = await discoverGrokSessionsDirs({ env: {}, homeDir: path.join(FIXTURES, "empty-root") });
  assert.deepEqual(result, []);
});

test("discoverGrokSessionsDirs honors GROK_SESSIONS_DIRS env (comma-separated, overrides probe)", async () => {
  const result = await discoverGrokSessionsDirs({
    env: { GROK_SESSIONS_DIRS: "  /tmp/a , ,/tmp/b  ," },
    homeDir: DISCOVERY_HOME,
  });
  assert.deepEqual(result, ["/tmp/a", "/tmp/b"]);
});
