import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadState,
  saveState,
  recordSuccess,
  DEFAULT_STATE,
  type ReportingState,
} from "../reporter/reporting-state";

function tmpStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-state-"));
  return path.join(dir, ".reporting-state.json");
}

describe("last_success_at round-trip", () => {
  test("defaults to null when the state file does not exist", () => {
    assert.strictEqual(loadState(tmpStateFile()).last_success_at, null);
    assert.strictEqual(DEFAULT_STATE.last_success_at, null);
  });

  test("defaults to null when the state file predates the field", () => {
    const f = tmpStateFile();
    // A state file written by an older reporter — no last_success_at key at all.
    fs.writeFileSync(f, JSON.stringify({ dev_stats_on: true, session_stats_on: true }), "utf-8");
    const state = loadState(f);
    assert.strictEqual(state.last_success_at, null);
    // The pre-existing fields must survive the upgrade untouched.
    assert.strictEqual(state.dev_stats_on, true);
    assert.strictEqual(state.session_stats_on, true);
  });

  test("saveState persists last_success_at rather than normalizing it away", () => {
    const f = tmpStateFile();
    const state: ReportingState = {
      dev_stats_on: false,
      session_stats_on: false,
      last_success_at: "2026-08-18T00:00:00.000Z",
    };
    saveState(f, state);
    assert.strictEqual(loadState(f).last_success_at, "2026-08-18T00:00:00.000Z");
  });

  test("a non-string last_success_at is rejected, not passed through", () => {
    const f = tmpStateFile();
    fs.writeFileSync(f, JSON.stringify({ last_success_at: 12345 }), "utf-8");
    assert.strictEqual(loadState(f).last_success_at, null);
  });
});

describe("recordSuccess", () => {
  test("stamps the timestamp without disturbing the persisted toggles", () => {
    const f = tmpStateFile();
    saveState(f, { dev_stats_on: true, session_stats_on: true, last_success_at: null });

    recordSuccess(f, "2026-08-18T12:00:00.000Z");

    const after = loadState(f);
    assert.strictEqual(after.last_success_at, "2026-08-18T12:00:00.000Z");
    assert.strictEqual(after.dev_stats_on, true);
    assert.strictEqual(after.session_stats_on, true);
  });

  // The frozen-profile path in report.ts deliberately skips saveState, so
  // recordSuccess must not become a back door that persists the in-memory
  // toggles the freeze was meant to withhold.
  test("does not persist toggles the caller never wrote", () => {
    const f = tmpStateFile();
    saveState(f, { dev_stats_on: false, session_stats_on: false, last_success_at: null });

    recordSuccess(f, "2026-08-18T12:00:00.000Z");

    const after = loadState(f);
    assert.strictEqual(after.dev_stats_on, false);
    assert.strictEqual(after.session_stats_on, false);
  });

  test("overwrites an earlier success stamp", () => {
    const f = tmpStateFile();
    saveState(f, { dev_stats_on: false, session_stats_on: false, last_success_at: "2026-08-01T00:00:00.000Z" });
    recordSuccess(f, "2026-08-18T12:00:00.000Z");
    assert.strictEqual(loadState(f).last_success_at, "2026-08-18T12:00:00.000Z");
  });
});
