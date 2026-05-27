---
name: feedback-portable-sources
description: When adding a tkmx reporting source, design portably — the source is the AGENT (e.g. "openclaw"), not the host wrapper (e.g. "plow")
metadata:
  type: feedback
---

When adding a new reporting source to tkmx-client, design portably across users / machines / OSes / host wrappers. The source is the **agent** (e.g. "openclaw", "claude", "codex"), not the **host** that wraps it (e.g. "plow"). A given agent often lives in multiple places: standalone install, wrapped by host A, host A's dev variants, host B, etc.

**Why:** tkmx-client ships to many users with different setups. Hardcoding one install path ("the macOS plow path") makes it useless to a user who installs OpenClaw standalone, runs Plow dev variants (`co.plow.app.dev.wt1`, `.wt2`, ...), or eventually runs OpenClaw under a non-Plow host. Existing precedent: `EXTRA_CLAUDE_CONFIGS` is comma-separated (`reporter/report.ts:241-263`); `agentsview` probes multiple known install roots itself. The user pushed back on a plan that defaulted to one plow-specific path.

**How to apply:** For any new collector — (1) name the env var after the agent (`OPENCLAW_SESSIONS_DIR`, not `PLOW_*`); (2) accept multiple paths comma-separated; (3) discovery default = scan a known list of probe roots (standalone path first, then known wrapper paths), each contributing its session data; (4) emit `source` tagged with the agent name; (5) gracefully no-op if no roots resolve. The README section should be titled by the agent and list host-wrapper paths as examples, not as the default.
