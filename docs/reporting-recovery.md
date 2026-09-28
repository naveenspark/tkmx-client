# Recover stopped reporting

The data path is agent transcripts, the dedicated AgentsView reporting archive,
the scheduled reporter, then the Builder Index. A running AgentsView server does
not establish that imports or uploads are current. A server started with
`--no-sync` depends on explicit refreshes from the reporter.

## Inspect

On macOS, inspect the existing job and its log:

```sh
launchctl print "gui/$(id -u)/com.token-tracking.reporter"
tail -n 80 "$HOME/Library/Logs/token-tracking-reporter.log"
```

Check the timestamp of the last accepted upload and look for sync timeouts.
Scheduled runs can upload the last cached snapshot when refresh fails; HTTP 200
alone does not prove current usage. An absent job can leave its plist on disk.

Preserve `.env`, especially `CLIENT_ID`. Keep the configured reporting archive
and pinned AgentsView binary. Use the existing tool-update policy; recovery is
not an automatic upgrade. Avoid running a manual backfill alongside the job.

## Verify storage policy before a large refresh

The reporter requests usage-only storage, but an already running AgentsView
daemon uses the policy it loaded at startup. Client environment variables do
not change that daemon's policy. In AgentsView v0.44.0, persist this top-level
setting in the reporting data directory's `config.toml`:

```toml
archive_content = "usage"
```

Preserve the other configuration values. Before changing storage policy or
restarting the identified reporting daemon, make a consistent SQLite backup
and check its integrity. Do not copy just the live database file while WAL
writes may be pending. Preserve the original transcripts.

Restart the reporting daemon under the same data directory, then test one
small, real source session that is absent from its archive. Compare the source
token counts with the stored counts and verify that message and reasoning text
are empty. A successful command against an unchanged, already imported file
can return old rows without rewriting them; that does not test the new policy.

The setting applies to subsequent writes. It does not compact existing rows
or immediately reclaim database space. Keep historical cleanup separate from
reporting recovery, and do not use a full rebuild or older binary as a shortcut.

## Refresh and backfill

From this checkout, use the existing report command with a temporary window
covering the whole gap. For a gap shorter than a week:

```sh
REPORT_DAYS=7 npm run report
```

Use a larger window for an older gap. This leaves the steady-state `.env` value
unchanged. With the same client identity, the server updates existing daily
usage rows rather than treating the backfill as another machine.

Wait for the command to finish successfully. Confirm the local archive contains
recent sessions and the log contains an accepted upload. A filesystem device-ID
change can cause AgentsView to reparse older files despite unchanged inode
numbers. Let the supported importer finish; do not rewrite identity bookkeeping
or discard the archive to skip that check. Original transcripts are its input.

## Restore an absent macOS job

When the existing plist is valid, its executable paths still exist, and the job
is absent but enabled, load that exact job:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.token-tracking.reporter.plist"
launchctl print "gui/$(id -u)/com.token-tracking.reporter"
```

The existing plist runs once on load and then every two hours. Verify that the
load-triggered report finishes, uploads successfully, and exits with code zero.
Check archive freshness again and inspect the public profile. Loading the job
does not by itself prove persistence across a future reboot.

If the plist is missing or its paths are invalid, use the documented
`npm run install-service` flow after reviewing its replacement plan. Never load
another job or stop a pre-existing AgentsView daemon as incidental cleanup.
