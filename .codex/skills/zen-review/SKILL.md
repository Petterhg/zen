---
name: zen-review
description: Review a Zen branch or PR for concrete correctness, pairing UX, privacy and validation regressions without editing code.
---

# zen-review

Read AGENTS.md, compare the requested base to the target, and inspect affected execution paths. Prioritize stale edit application, accidental speech interruption, privacy/context-sharing bypass, key leakage, cancellation races, false complete coverage and broken clean setup. Check whether tests exercise observable behavior rather than simply matching implementation text.

Return actionable findings with severity, file/line, trigger and consequence. Distinguish proven defects from questions and unavailable validation. Do not invent issues to fill a quota, request unrelated refactors, modify files, or run paid/live tests without authorization. If no actionable findings remain, say so and state the material validation gaps. A review does not authorize merge or release.
