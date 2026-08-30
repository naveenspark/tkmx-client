# Reliable AgentsView Sync Under Service Managers

## Goal

Make configured extra-home token collection reliable when the reporter runs
under a service manager, and upstream a general AgentsView improvement for
large archives whose healthy daemon startup exceeds the fixed readiness
deadline.

## Observed Failure

The reporter currently collects each configured extra home by invoking
`agentsview usage daily` without `--no-sync`. Current AgentsView releases make
that command daemon-first: the CLI starts a background daemon, the daemon runs
its initial synchronization, and the CLI waits up to 90 seconds for readiness.

Under systemd, that daemon is a child of the reporter service and is removed
with the service cgroup after the report finishes. Every scheduled report
therefore performs another cold daemon start. A large isolated archive can make
healthy synchronization progress for longer than 90 seconds, causing the
reporter to fail before it posts any usage.

The production reproduction used an 8.1 GB isolated archive. The normal path
failed at AgentsView's 90-second daemon-readiness deadline. With only
`AGENTSVIEW_NO_DAEMON=1` changed, a direct sync completed successfully in 73
seconds; the following `usage daily --no-sync` query completed in 15 seconds.

## Client Design

Extra-home collection will use two explicit phases:

1. Run `agentsview sync` with the extra home's existing data-directory and
   source-directory environment plus `AGENTSVIEW_NO_DAEMON=1` and
   `WARP_DIR=/var/empty`. Discard stdout so large progress output cannot exceed
   Node's child-process buffer. Capture stderr for actionable failures.
2. Only after a successful sync, run the existing single-agent
   `agentsview usage daily` query with `--no-sync` against the same isolated
   data directory.

The extra-home sync is strict on systemd and in interactive runs. A non-zero
exit, timeout, or spawn error aborts the report, preserving the existing
guarantee that a configured home cannot be silently omitted. Under the
installed launchd job, where AgentsView writes deadlock, configured extra homes
fail immediately because an existing snapshot cannot prove freshness. The
default local index keeps its existing best-effort sync behavior because its
explicit contract permits a previously synchronized snapshot.

No service-manager configuration changes are required. In particular, the
reporter will not preserve unmanaged child daemons or install one daemon per
extra account.

## Client Interfaces and Ownership

`reporter/agentsview.ts` remains the sole owner of AgentsView process behavior.
It will expose a strict sync operation used by
`collectAgentsviewAgentOnly`. The existing `queryAgent` operation remains the
single JSON parsing boundary and always reads with `--no-sync`.

`reporter/report.ts` will keep validating extra-home paths and attaching the
home name to any error. It will not learn command flags or daemon policy.

## Client Tests

Tests will prove observable process behavior with the existing fake
AgentsView binary:

- extra-home collection invokes `sync` before `usage daily`;
- the strict sync receives `AGENTSVIEW_NO_DAEMON=1`, the isolated data
  directory, the configured source directory, and the Warp guard;
- the query receives `--no-sync` and the same isolated/source directories;
- a strict sync failure throws and prevents the query;
- a strict sync timeout throws and prevents the query;
- the installed launchd job fails configured extra-home collection immediately
  without attempting a write or posting stale data;
- local-index synchronization remains best-effort;
- the end-to-end reporter still refuses to POST when configured extra-home
  collection fails.

The canonical client gate remains `npm test` under Node 22.

## AgentsView Upstream Design

The upstream change is independent of the client fix. AgentsView already
publishes structured startup state while a daemon performs initial sync, but
automatic daemon startup uses a fixed 90-second absolute readiness deadline.
The readiness wait should instead treat advancing startup state as evidence of
health:

- retain a 90-second inactivity deadline;
- reset that inactivity deadline when the published startup snapshot advances;
- return immediately when a writable runtime record appears or the child
  exits;
- retain context cancellation so callers can impose an outer deadline;
- time out when startup state stops advancing for 90 seconds.

This preserves bounded failure for a stalled daemon while allowing a large,
healthy archive to finish. The upstream tests will cover progress extending
past the former absolute deadline, stalled progress timing out, child exit, and
context cancellation. The upstream PR must contain no private hostnames,
paths, account names, or infrastructure details.

The client will not depend on this upstream change or on a future AgentsView
release.

## Delivery and Runtime Verification

The client change will be delivered through its own feature branch and pull
request. After exact-head review convergence and authorized merge, the deployed
service clone on the affected Linux reporter will be updated and rebuilt. A
manual service run must exit successfully, receive an HTTP 200 response, and
advance that machine's timestamp in the Builder Index API. A subsequent timer
run must also succeed, proving the result is not a one-shot warm-cache effect.

The two additional Mac reporters will be checked from their deployed service
clones for enabled schedules, zero exit status, recent HTTP 200 responses, and
fresh Builder Index timestamps. They need no configuration changes if those
checks remain healthy.

The AgentsView change will be developed and tested separately against its
current main branch, then submitted as an independent upstream pull request.
It will not be deployed into production before upstream acceptance and a
released binary.
