import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { collectOpenclawUsage } from "../reporter/openclaw";

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
