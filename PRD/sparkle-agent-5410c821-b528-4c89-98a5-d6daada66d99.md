## Progress Update as of 2026-08-25 04:56 PDT
*(Most recent updates at top)*

### Summary of changes since last update
Closed the three open review probes on PR #71, which had been sitting unread at
the current head while a stale comment on the PR claimed it was ready to land.
Took the blocking one as a guard and the two mediums as deletions. Net -218 LOC.

### Detail of changes made:
- **The client no longer assesses its own health, and no longer sends one.**
  This was the reviewer's central point and it is correct: a reporter that has
  stopped cannot run `report.ts`, so the one machine that most needs to be
  noticed is precisely the one that sends nothing. The unattended gone-quiet
  signal belongs to the side still awake — the server, reading its own last
  accepted POST. Deleted the `reporter_health` wire field and its interface, the
  in-cycle self-check, `last_success_at` on `ReportingState`, `recordSuccess`,
  and the doctor staleness branch. `npm run doctor` survives as what it is good
  at: an on-demand answer to "is this machine's plumbing intact".
- **That deletion also dissolves a defect rather than papering it.** The old
  code read `last_success_at` *before* the POST, so a reporter recovering after
  a two-day outage judged itself against the pre-recovery stamp and reported
  `healthy:false` on the very run that proved it healthy — a false positive
  handed to the server's gone-quiet list.
- **Windows no longer reports itself broken.** `collectInput()` selected the
  systemd unit path for every non-darwin platform, so on Windows it hunted for a
  unit `install-service` refuses to write, found none, and called a machine that
  never had a reporter broken. The platform check is now a pure exported
  `assertSupportedPlatform()` that rejects before any unit path is chosen —
  pure so the refusal is reachable in a test without pretending to be Windows,
  which is the same pure-core/thin-probe split the rest of the file uses.
- **`uninstall.ts` uses the canonical systemd path helpers** instead of
  rebuilding both paths by hand, so uninstall cannot look at a different file
  than install wrote. Dropped its now-unused `node:path` import.

### Beads activity:
- `builder-index-client-85j` (P0, silent churn) still in progress; this branch
  is the client half only, and after this change that half is deliberately just
  the on-demand diagnostic. The unattended detection is server-side work.

### Potential concerns to address:
- The reviewer also asked that this PR be closed and resubmitted as two. That is
  a judgement about the PR, not about the code, so it is answered on the PR and
  left to a human rather than acted on unilaterally.
- Local verification note: this machine runs Node 26, for which `better-sqlite3`
  has no prebuilt binary and `node-gyp` cannot build one, so the sqlite-backed
  tests cannot run under the default interpreter here. Verified under Node 22
  instead: 282/287 pass. The 5 failures are all in `resolveAgentsview` /
  `collectSessionStats` "binary missing" cases, which fail because a real
  `agentsview` binary is installed on this machine; they are in files this
  change does not touch, and CI is green on them.

## Progress Update as of 2026-08-18 12:40 PT
*(Most recent updates at top)*

### Summary of changes since last update
Addressed all three roborev findings on 80a159b. One was a real first-run bug:
a freshly installed reporter indicted itself.

### Detail of changes made:
- `reporter/doctor.ts`: a null/unparseable `last_success_at` is now `warn`, not
  `fail`. launchd's `RunAtLoad` fires a cycle the instant the unit is installed,
  before any success can have been stamped — the old behaviour printed
  "BROKEN" into the log of a reporter that was working, and put
  `healthy: false` on the very POST that proved it worked, which would have
  handed the server-side gone-quiet list a false positive for every new
  builder. A genuinely dead reporter is still caught by the unit checks and by
  the staleness branch once it has ever worked. Verified: a fresh install with
  a good unit and no success now reports `healthy: true` with one warn.
- `test/report-e2e.test.ts`: asserts `reporter_health` actually reaches the POST
  body (`healthy:false`, `failing_checks` containing `service-installed`).
  Nothing covered the new wire field, so a never-firing `if (health)` guard or
  a renamed key would have gone green.
- `test/reporting-state.test.ts`: converted from per-test
  `require("../reporter/reporting-state")` to typed top-level imports plus a
  `tmpStateFile()` helper. The `require()` results were `any`, which is exactly
  why the restored `computeTransitionMarkers` literals could omit
  `last_success_at` unnoticed; they are now typed `ReportingState`.

### Beads activity:
- No status changes. builder-index-client-85j stays open pending
  builder-index-client-4k7 (server half).

### Potential concerns to address:
- Suite is 297 tests, 292 passing; the same 5 pre-existing failures
  (builder-index-client-trk) remain and are unrelated to this work.

## Progress Update as of 2026-08-18 12:20 PT
*(Most recent updates at top)*

### Summary of changes since last update
First entry. Landed the client half of builder-index-client-85j (P0, silent
churn): this machine now records when the server last accepted a report, and a
new `npm run doctor` diagnoses the three ways a reporter dies quietly — no unit
installed, the unit pointing at a node binary that no longer exists, and a unit
that exists but is not scheduled. The same check runs inside every report cycle,
because the failure mode is that nobody looks.

### Detail of changes made:
- The branch started as an ORPHAN — `git merge-base HEAD origin/main` was empty
  and the tree held only `AGENTS.md`/`CLAUDE.md`. It was re-cut with
  `git checkout -B <branch> origin/main`, discarding a `bd init` scaffolding
  commit that shared no history with main. Any future agent seeing an empty
  merge-base should re-cut rather than attempt a rebase.
- `reporter/reporting-state.ts`: `ReportingState` gains `last_success_at`
  (`string | null`). `loadState` treats a non-string as null so a state file
  written before this field, or hand-edited, reads as "never succeeded" rather
  than manufacturing freshness. New `recordSuccess(filePath, nowIso)` reloads
  and rewrites only that field.
- `reporter/report.ts`: `currentState` carries `last_success_at` forward from
  `priorState` — rebuilding it from env alone would erase the stamp every run.
  `recordSuccess` is called after a successful POST and OUTSIDE the
  `!profile_frozen` gate: a frozen profile still proves the collector ran and
  reached the server, which is what staleness is about. The body now carries a
  `reporter_health` block for the server half to read.
- `reporter/doctor.ts` (new): pure `diagnose()` over an injected `DiagnoseInput`
  plus thin impure probes (`collectInput`, `probeScheduled`, plist/systemd
  parsers). Threshold is 48h — a laptop shut for a long weekend must not be
  called broken. A future-dated stamp warns instead of passing as fresh.
- `reporter/install.ts`: exported `launchdPlistPath`/`systemdServicePath`/
  `systemdTimerPath`, replacing the same paths built inline in install and
  uninstall. Doctor must read the file install wrote, not one it recomputed.
- `test/report-e2e.test.ts`: the frozen-profile test asserted "the state file
  does not exist" as a proxy for "the transition edge was not consumed". That
  proxy died the moment the file also held `last_success_at`, so it now asserts
  the invariant directly — the persisted toggles stay put AND the stamp lands —
  and was mutation-checked to confirm it still fails if `saveState` moves
  outside the freeze gate.

### Beads activity:
- Claimed and implemented (client half): builder-index-client-85j
- Opened: builder-index-client-4k7 (server half; 85j now depends on it, so 85j
  stays open until the profile/operator/email signal exists)
- Opened: builder-index-client-trk (test isolation — a real agentsview binary
  on the machine leaks into tests that assume none)
- Opened: builder-index-client-cvq (better-sqlite3 will not build on Node 26)
- Closed: builder-index-client-mxk (repo already has its origin remote)

### Potential concerns to address:
- The suite has 5 PRE-EXISTING failures on this machine, unrelated to this work
  (builder-index-client-trk). Baseline was 267/272 passing; after this change it
  is 282/287 with the same 5 failing. Anyone verifying should compare against
  the baseline, not expect green.
- Tests must be run under Node 22 (`nvm use 22`) until
  builder-index-client-cvq is fixed; Node 26 cannot build better-sqlite3.
- `reporter_health` is sent but nothing consumes it. Until 4k7 lands, the
  builder-facing half of 85j's acceptance criteria is unmet — detection exists,
  notification does not.
- The systemd probe path is untested on a real Linux box, matching the existing
  caveat already noted in `reporter/uninstall.ts`.
