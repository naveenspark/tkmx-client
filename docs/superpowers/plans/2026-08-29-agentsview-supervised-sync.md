# Reliable AgentsView Supervised Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make configured extra-home collection perform a strict direct
AgentsView sync before a daemon-free-of-initial-sync usage read.

**Architecture:** Keep process policy inside `reporter/agentsview.ts`. Add a
strict sync variant that shares the existing bounded child-process behavior but
forces AgentsView's supported direct-write path. Extra-home collection calls it
before the existing parser boundary, while local-index collection retains its
best-effort semantics.

**Tech Stack:** TypeScript, Node.js 22 child processes, Node test runner,
shell-based fake AgentsView fixtures.

## Global Constraints

- A configured extra home must never be silently omitted from a successful
  report.
- Local-index sync remains best-effort and may read a last-synced snapshot.
- Sync stdout is discarded and stderr is preserved.
- The strict sync environment includes `AGENTSVIEW_NO_DAEMON=1` and
  `WARP_DIR=/var/empty` without discarding the caller's isolated data/source
  variables.
- Usage reads happen only after strict sync succeeds and include `--no-sync`.
- The canonical gate is `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test`.

---

### Task 1: Pin strict extra-home process behavior

**Files:**
- Modify: `test/agentsview.test.ts`
- Test: `test/agentsview.test.ts`

**Interfaces:**
- Consumes: existing `collectAgentsviewAgentOnly(bin, sinceStr, agent, env,
  timeoutMs)`.
- Produces: regression coverage for strict sync ordering, environment, query
  flags, failure, and timeout.

- [ ] **Step 1: Import the extra-home collector**

Add `collectAgentsviewAgentOnly` to the existing import from
`../reporter/agentsview`.

- [ ] **Step 2: Write the successful ordering and environment test**

Add a test whose fake executable records `AGENTSVIEW_NO_DAEMON`, `WARP_DIR`,
`AGENT_VIEWER_DATA_DIR`, `CODEX_SESSIONS_DIR`, and argv. Call
`collectAgentsviewAgentOnly` with an isolated data directory and source
directory. Assert the first line is the direct `sync` call, the second line is
`usage daily`, the sync carries both guard variables, and the usage call carries
`--no-sync` without the Warp guard.

- [ ] **Step 3: Write strict failure tests**

Add one fake whose `sync` exits non-zero and another whose `sync` exceeds a
short timeout. Assert both calls throw an `agentsview sync failed` error and the
fake invocation log contains no `usage` call.

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:tests
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --test \
  --test-name-pattern='collectAgentsviewAgentOnly' dist/test/agentsview.test.js
```

Expected: the ordering test fails because no standalone sync occurs, and the
failure tests fail because the existing combined query reports an agent-query
error or proceeds with the wrong invocation shape.

### Task 2: Implement strict direct synchronization

**Files:**
- Modify: `reporter/agentsview.ts`
- Test: `test/agentsview.test.ts`

**Interfaces:**
- Produces: `syncAgentsviewOrThrow(bin: string, timeoutMs?: number,
  extraEnv?: Record<string, string>): void`.
- Consumes: `queryAgent(..., noSync=true, ...)` after successful strict sync.

- [ ] **Step 1: Extract shared sync execution options**

Create a private helper that builds the existing `execFileSync` options with
UTF-8 stderr, `SIGKILL`, discarded stdout, caller environment, and the Warp
guard. Give it an explicit boolean for direct mode; direct mode adds
`AGENTSVIEW_NO_DAEMON: "1"`.

- [ ] **Step 2: Add the strict sync operation**

Implement `syncAgentsviewOrThrow` with `execFileSync(bin, ["sync"], opts)`.
On failure, prefer captured stderr and otherwise use `errMessage(err)`, then
throw `new Error("agentsview sync failed: " + detail)`.

- [ ] **Step 3: Preserve the local best-effort operation**

Refactor `syncAgentsview` to use the shared options without direct mode and
retain its `boolean` return and existing log message exactly in behavior.

- [ ] **Step 4: Split extra-home collection into two phases**

Change `collectAgentsviewAgentOnly` to call
`syncAgentsviewOrThrow(bin, timeoutMs, env)`, then perform a `--no-sync` query.
For the installed launchd job, fail configured extra-home collection
immediately rather than enter the deadlocking write or post a stale snapshot.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the focused commands from Task 1. Expected: all matching tests pass.

- [ ] **Step 6: Run the full canonical gate**

Run:

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test
```

Expected: 272 or more tests pass with zero failures.

- [ ] **Step 7: Commit the implementation**

```bash
git add reporter/agentsview.ts test/agentsview.test.ts \
  docs/superpowers/plans/2026-08-29-agentsview-supervised-sync.md
git commit -m "fix: sync extra agentsview homes without daemons"
```

### Task 3: Deliver and verify the client change

**Files:**
- No new source files.
- Runtime: deployed `tkmx-client` service clones.

**Interfaces:**
- Consumes: the merged client commit.
- Produces: fresh successful server reports from the affected Linux reporter
  and verified healthy Mac reporters.

- [ ] **Step 1: Push and open the client pull request**

Push `fix/agentsview-supervised-sync` to the configured origin and open a PR
whose summary explains strict direct sync, unchanged fail-loud behavior, and
the production reproduction.

- [ ] **Step 2: Run the exact-head convergence loop**

Use `$babysit-pr` on the opened PR. Independently verify findings, apply only
within-intent fixes, rerun the canonical gate after changes, push once per
round, and request one `/srosro-update-review` after each new head until the
current head is clean and required checks pass.

- [ ] **Step 3: Merge the converged client PR**

Re-fetch the head SHA and convergence state immediately before merging. Merge
without an administrative bypass only when the current head is converged.

- [ ] **Step 4: Deploy the merged commit to the affected Linux service clone**

Fetch and fast-forward its `main`, install/build with its Node runtime, and
restart or manually start the reporter service without modifying its `.env`.

- [ ] **Step 5: Verify two successful Linux reports**

Require one immediate successful run and one later timer-triggered successful
run. Each must exit zero, log HTTP 200, collect every configured extra home,
and advance the machine timestamp in the Builder Index API.

- [ ] **Step 6: Verify both Mac reporters**

For each deployed Mac service, verify the launch agent is loaded, its latest
exit code is zero, its log contains a recent HTTP 200, and its Builder Index
machine timestamp is current. Do not change their configuration when these
checks pass.
