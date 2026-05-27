import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { collectOpenclawUsage, parseUsageLine } from "../reporter/openclaw";

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
