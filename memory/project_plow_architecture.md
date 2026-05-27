---
name: project-plow-architecture
description: Plow is an agent container — runs OpenClaw today, Hermes planned; tkmx reporting should be source-aware for the contained agent
metadata:
  type: project
---

OpenClaw is the agent; Plow is one *host* that wraps it. OpenClaw is upstream-independent (category (a) in plow's [[reference-plow-taxonomy]]) — it can run standalone (`~/.openclaw/`), wrapped by Plow (`~/Library/Application Support/co.plow.app/openclaw/gateway/agents/*/sessions/`), wrapped by Plow dev variants (`co.plow.app.dev.wt1`, `.wt2`, ...), or in the future by other hosts. Plow today wraps OpenClaw and is planned to wrap Hermes later.

**Why:** Tying tkmx-client reporting to "plow" (the host) instead of "openclaw" (the agent) would (a) miss users running standalone OpenClaw, (b) require schema rework when Hermes ships, (c) silently lose dev-variant data, (d) ship a path that only works on the author's macOS plow install. See [[feedback-portable-sources]] for the design rule.

**How to apply:** tkmx source label = `openclaw` (and later `hermes`), never `plow`. Discovery scans a list of known OpenClaw roots — standalone + each known host-wrapper + dev variants — with env-var override. Each found root contributes its session data, aggregated under the agent's source tag. The reporter never assumes a host is present.
