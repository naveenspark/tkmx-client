// Drift guard for the Builder Index profile — the checked-in tripwire behind
// test/fixtures/profile-canonical.json.
//
// WHY THIS TEST EXISTS
//
// The profile's prose fields have silently reverted to a stale value four separate
// times. Every previous fix was a data-level correction posted against the API, and
// every one was undone within about two hours by a machine nobody had identified.
// Each recurrence started the same investigation from zero, because the profile
// records WHAT it holds and never WHO put it there.
//
// So the expensive part was never the correction. It was attribution. This test's
// real product is its failure message: on any assertion failure it prints every
// client_id that reports under this profile, sorted newest-report-first, so the
// question "which machine should I go look at?" is answered by reading the output
// instead of by a fifth investigation.
//
// WHAT IT DOES NOT CLAIM. `machines[].updated_at` is when that client last REPORTED,
// not when it last wrote the field that drifted. The server does record the real
// answer — buildApiKeyFieldOps emits a profile_update event carrying field, old_value
// and new_value — but no GET route exposes it, so the newest reporter is the best
// attribution available from outside. The output says so rather than implying more
// precision than it has. Exposing that event feed would make this exact, and is the
// single highest-value change to the server for this class of bug.
//
// AND IT IS NOT A RANKING. Do not read "most recent reporter" as "the culprit" — the
// output says REPORTER throughout, never writer, because reporting is the only thing
// updated_at measures. On 2026-08-20 the CORRECT value sat on a box that had not
// reported in six days while a box reporting every two hours kept overwriting it: the
// freshest reporter was the wrong machine. The line names somewhere to start looking;
// ownership is declared in the fixture, never inferred here.
//
// CI POSTURE: skips (exit 0) only when the host cannot be REACHED — a transport
// failure, or a 5xx/429 saying it is unwell. Everything else asserts, including a 404
// and a 200 whose body breaks the contract; see fetchProfile for why that line is
// where it is. A guard that reddens the build on someone else's outage gets commented
// out, but one that exits 0 on a deleted profile guards nothing. The residual trade is
// stated plainly: an outage hides drift for that run, so this is a ratchet against a
// value changing SILENTLY, not an uptime monitor.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
// The SAME source the reporter posts as client_version (reporter/report.ts imports
// this exact field). Read rather than restated, so a release bump cannot leave the
// guard asserting against a version nothing sends.
import { version as CLIENT_VERSION_IMPLEMENTED } from "../package.json";

const CANONICAL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "profile-canonical.json"), "utf8"),
);

const TIMEOUT_MS = 15_000;

interface Machine {
  client_id?: string;
  hostname?: string;
  os?: string;
  cpu?: string;
  memory_gb?: number;
  client_version?: string;
  agentsview_version?: string;
  updated_at?: string;
}

/// Returns the profile, or null when the API could not be REACHED. Null means SKIP.
///
/// A reachable API that answers wrongly is NOT a skip — it throws, and the test fails.
/// The distinction matters and the earlier revision of this file got it wrong: it
/// collapsed a transport error, a non-200, and a 200 carrying an HTML error page into
/// one "unreachable" branch, so a genuine contract break exited 0 while the file's own
/// comment claimed it asserted hard. Three outcomes, deliberately:
///   * transport error / timeout, or 5xx / 429 — SKIP. The host is having a moment;
///     that is not this repo's regression, and a guard that reddens the build on
///     someone else's outage is one that gets commented out.
///   * any other non-200 (a 404 means the profile is GONE, a 401 that it went private)
///     — FAIL. Those are exactly the drift this file exists to catch.
///   * 200 whose body is not JSON, or carries no machines array — FAIL. The endpoint
///     answered and the answer does not satisfy the contract.
async function fetchProfile(): Promise<Record<string, unknown> | null> {
  // Read off globalThis rather than calling `fetch` directly: the tsconfig lib is
  // ES2022, which does not declare it, and this file must compile without pulling a
  // DOM lib in for one call.
  const fetchFn = (globalThis as { fetch?: (...a: unknown[]) => Promise<unknown> }).fetch;
  if (typeof fetchFn !== "function") return null;

  let res: any;
  try {
    res = await fetchFn(CANONICAL.api_url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    return null;  // never reached the host
  }

  if (res.status >= 500 || res.status === 429) return null;  // reached, host unwell
  assert.equal(res.status, 200, `${CANONICAL.api_url} answered ${res.status} — the profile is not readable`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    assert.fail(`${CANONICAL.api_url} answered 200 with a body that is not JSON`);
  }
  assert.ok(
    body && typeof body === "object" && Array.isArray((body as any).machines),
    `${CANONICAL.api_url} answered 200 but the body carries no machines array`,
  );
  return body as Record<string, unknown>;
}

/// The attribution report. This is the point of the whole file, so it is built
/// unconditionally on failure and appended to every assertion message.
function whoWroteThis(profile: Record<string, unknown>): string {
  const machines = ((profile.machines as Machine[]) || [])
    .slice()
    // Missing updated_at sorts last rather than throwing — a machine the server has
    // never timestamped is still worth naming.
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));

  const owner = CANONICAL.owner.client_id;
  const lines = machines.map((m, i) => {
    const marks = [
      i === 0 ? "← most recent reporter" : "",
      m.client_id === owner ? "← DECLARED PROSE OWNER" : "",
    ].filter(Boolean).join(" ");
    return [
      `    ${m.updated_at || "(never)"}  ${m.client_id || "(no client_id)"}`,
      `      host ${m.hostname || "?"} | ${m.cpu || "?"} | ${m.memory_gb ?? "?"}GB | ${m.os || "?"}`,
      `      client ${m.client_version || "?"} | agentsview ${m.agentsview_version || "?"} ${marks}`,
    ].join("\n");
  });

  const newest = machines[0];
  const ownerPresent = machines.some((m) => m.client_id === owner);

  return [
    "",
    "  ── WHICH MACHINE IS WRITING THIS PROFILE ────────────────────────────────",
    `  Machines reporting under ${CANONICAL.profile}, newest report first:`,
    ...lines,
    "",
    `  Declared prose owner: ${owner}`,
    ownerPresent ? "" : "  WARNING: the declared owner is not in this list at all — it has never reported,",
    ownerPresent ? "" : "  or its client_id changed. Prose has no legitimate writer until that is resolved.",
    newest && newest.client_id !== owner
      ? `  The newest report is from ${newest.client_id} (${newest.hostname || "?"}), which is NOT the\n  owner. Start there — but read the caveat below before concluding it is the culprit.`
      : "  The newest report is from the declared owner.",
    "",
    "  CAVEAT: updated_at is when that client last REPORTED, not when it last wrote the",
    "  drifted field, and the newest reporter is NOT necessarily the wrong machine — a stale",
    "  box has held the correct value while a busy box overwrote it. The server records",
    "  the exact answer as a profile_update event (field/old_value/new_value) but exposes",
    "  no route to read it; until it does, this is the best attribution available.",
    `  Human-readable profile: ${CANONICAL.human_url}`,
    "  ─────────────────────────────────────────────────────────────────────────",
  ].filter((l) => l !== "").join("\n");
}

test("builder index profile has not drifted from canonical", async (t) => {
  const profile = await fetchProfile();
  if (!profile) {
    t.skip(`could not reach ${CANONICAL.api_url} — skipping rather than reddening the build on a third-party outage`);
    return;
  }

  const who = whoWroteThis(profile);
  const failures: string[] = [];

  // ── scalar fields, pinned exactly ────────────────────────────────────────────
  //
  // These are SCALAR_API_KEY_FIELDS on the server: an empty string is a string, so it
  // passes the only type guard and BLANKS the stored value. They are the fields a
  // misconfigured client can actually destroy, so nothing less than exact is enough.
  for (const [key, want] of Object.entries(CANONICAL.strict as Record<string, string>)) {
    if (key.startsWith("_")) continue;
    const got = profile[key];
    if (got === want) continue;

    const bad = (CANONICAL.known_bad?.[key] as string[] | undefined) || [];
    const recurrence = bad.includes(got as string)
      ? `\n  THIS IS A KNOWN RECURRENCE — ${JSON.stringify(got)} is a value this profile has reverted to before.\n  It is not new drift; it is the same regression again.`
      : "";
    const blanked = got === ""
      ? "\n  The live value is the EMPTY STRING. Per server/db.ts buildApiKeyFieldOps, only an\n  explicit empty string can do this — a client that OMITS the key is ignored. So some\n  client sent \"\" rather than sending nothing."
      : "";

    failures.push(
      `${key} drifted\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}${recurrence}${blanked}`,
    );
  }

  // ── scalar fields pinned by identity, not by casing ──────────────────────────
  //
  // Same destroy-by-empty-string exposure as above, so still pinned — but compared
  // case-insensitively, because the casing carries no meaning and changes for
  // reasons that are not regressions. See the fixture's note.
  for (const [key, want] of Object.entries(CANONICAL.strict_case_insensitive as Record<string, string>)) {
    if (key.startsWith("_")) continue;
    const got = profile[key];
    if (typeof got === "string" && got.toLowerCase() === want.toLowerCase()) continue;
    const blanked = got === ""
      ? "\n  The live value is the EMPTY STRING — only an explicit \"\" can do that; an omitted key is ignored."
      : "";
    failures.push(
      `${key} drifted (compared case-insensitively)\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}${blanked}`,
    );
  }

  // ── fields that must merely be present and non-blank ─────────────────────────
  //
  // Pinning these exactly would fail on every legitimate edit, and a guard that cries
  // wolf gets deleted. Blanking is the failure that costs something, so that is what
  // is caught.
  for (const key of CANONICAL.non_empty.fields as string[]) {
    const got = profile[key];
    if (typeof got === "string" && got.trim() !== "") continue;
    failures.push(
      `${key} is blank or missing (got ${JSON.stringify(got)}) — it is expected to carry content.`,
    );
  }

  // ── the silent-freeze tripwire ───────────────────────────────────────────────
  //
  // Not prose, but the same class of bug: a state where the profile stops tracking
  // reality and nothing says so. The server freezes any profile whose client_version
  // is below minimum_client_version, answers the POST 200/ok:true anyway, and the
  // profile simply stops moving. Catching the minimum RISING is the only warning
  // available before that happens.
  const minimum = profile.minimum_client_version;
  const implemented = CLIENT_VERSION_IMPLEMENTED;
  if (typeof minimum === "string" && minimum.trim() !== "") {
    const cmp = (a: string, b: string) => {
      const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
      const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      }
      return 0;
    };
    if (cmp(minimum, implemented) > 0) {
      failures.push(
        `server minimum_client_version is now ${minimum}, ABOVE the ${implemented} this codebase\n` +
        `  implements. Every profile reporting at ${implemented} is being FROZEN — the POST still\n` +
        `  returns 200 with ok:true, so nothing else will tell you. Bump the version in package.json\n` +
        `  (which is what the reporter posts) and in ${CANONICAL.protocol.also_pinned_in}.`,
      );
    }
  }

  // A profile the server itself considers stale is frozen right now.
  if (profile.versions_outdated === true) {
    failures.push(
      "server reports versions_outdated: true — this profile is FROZEN on its last snapshot\n" +
      "  and is no longer tracking reality, regardless of what the values above say.",
    );
  }

  assert.equal(
    failures.length,
    0,
    `Builder Index profile drifted from test/fixtures/profile-canonical.json\n\n` +
      failures.map((f, i) => `  ${i + 1}. ${f}`).join("\n\n") +
      `\n${who}\n\n` +
      `  If the LIVE value is the correct one, update the fixture — that diff is the record.\n`,
  );
});
