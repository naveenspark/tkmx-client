---
name: reference-plow-taxonomy
description: Plow's file-taxonomy.md classifies files as upstream/wrapper/user-state — check it before designing anything that touches plow-adjacent paths
metadata:
  type: reference
---

`~/Hacking/plow/docs/architecture/file-taxonomy.md` is the authoritative classification for everything in the Plow universe. Five categories: **(a)** upstream OpenClaw runtime (pulled by `npm install -g openclaw@<v>`, lives in Lima VM only); **(b)** Plow wrapper code shipped in `Plow.app`; **(c)** per-install user state at `~/Library/Application Support/co.plow.app/...` (and `co.plow.app.dev.wt*` dev variants, and `~/.openclaw/` for standalone); **(d)** team-tracked Plow-agent skill bundles; **(e)** tracked Claude Code engineer skills (`.claude/skills/`).

Key facts when designing tkmx-client features that read plow/openclaw data:
- OpenClaw is (a) — independent of Plow; standalone path `~/.openclaw/`; plow-wrapped path includes `co.plow.app/openclaw/` subdir (note: under `openclaw/`, not `agent-runtime/`, despite what the taxonomy doc's row (c) implies).
- Session JSONL paths match the `**/agents/*/sessions/*.jsonl` glob and are listed as user-state in plow's `check_protected_paths.py` rule `user-state` — confirms safe to read at user-process privilege.
- Plow has many parallel dev install roots (`co.plow.app.dev.wt1`, `.wt2`, ...); a single hardcoded path is not portable.

When asked to read or attribute Plow-adjacent data, re-check this doc first to know which category applies and which path roots are real. The doc lives only in the plow checkouts (`~/Hacking/plow*`), not in tkmx-client.
