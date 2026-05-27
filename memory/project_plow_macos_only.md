---
name: project-plow-macos-only
description: Plow runs on macOS only — tkmx-client does not need cross-platform support for plow-wrapper paths
metadata:
  type: project
---

Plow is a macOS-only product. tkmx-client does not need to support Plow wrapper paths on Linux/Windows.

**Why:** Plow ships as `Plow.app` (a Swift macOS app, per [[reference-plow-taxonomy]] row (b)) and uses Lima (macOS-only VM tooling) — there is no Linux/Windows Plow install to probe. Adding Linux app-support glob roots would be dead code with no test coverage and no real-world consumer.

**How to apply:** When designing tkmx-client features that probe Plow paths, gate the probe on `process.platform === "darwin"` and don't add Linux/Windows branches unless the user explicitly asks. The standalone OpenClaw path (`~/.openclaw/`) is separate from Plow and is fine to probe cross-platform (OpenClaw the agent runs anywhere). This does NOT mean tkmx-client itself is macOS-only — it must still work on Linux/Windows for users who run other agents (Claude Code, Codex) there; just no Plow-specific paths.
