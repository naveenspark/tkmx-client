---
name: feedback-test-with-production-inputs
description: When wiring a new collector/handler, tests must use the EXACT input format the production call site passes — not a "close enough" format
metadata:
  type: feedback
---

When adding a new collector or handler that takes inputs from existing call sites, the tests must use the **exact same format** those call sites actually pass — not a similar-looking format that happens to also work.

**Why:** In this repo, the OpenClaw collector took a `sinceDateStr` parameter and compared it against ISO-format dates (`YYYY-MM-DD`) extracted from JSONL records. The unit tests passed ISO strings (`"2026-05-01"`), the e2e test passed REPORT_DAYS=3650 (which produced a sinceStr starting with `2016` that happened to sort below 2026 ISO strings before format divergence mattered). But production passed YYYYMMDD (`"20260429"`) from `formatSinceStr` in `window.ts`, and string compare `"2026-05-25" >= "20260429"` is always false (hyphen 45 < digit '0' 48). Result: every openclaw record was silently dropped in production with the default REPORT_DAYS=28 — invisible from the test suite, fatal in prod. Found in pre-PR review by a fresh-context reviewer subagent (commit 550ec83 fixes it).

**How to apply:**
- Before writing test inputs for a new collector, grep the production call site for the exact value being passed and copy it verbatim.
- Add at least one test that uses the production-format value (not a synthetic equivalent).
- When a date / id / token / opaque-string param has multiple plausible formats, prefer a final-review pass that asks "what does the caller actually pass?" — this is exactly where a fresh-context reviewer earns its keep.
- A test passing with REPORT_DAYS=3650 to "make the date math work" is a smell — it usually means the test is escaping a real production constraint.
