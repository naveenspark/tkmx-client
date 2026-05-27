import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { collectOpenclawUsage, parseUsageLine, aggregateRecords } from "../reporter/openclaw";

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
  // root-b alone: resp-abc-1 (deduped) and resp-ghi-1
  assert.equal(result.length, 2);
});
