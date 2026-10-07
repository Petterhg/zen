---
name: zen-editor
description: Implement Zen inline edits, cursor/focus behavior, panel UX, language tooling and pinned Code-OSS runtime overlays.
---

# zen-editor

Trace extension.ts, request-target.ts, assistance.ts and the relevant panel controls. Preserve the captured document identity and version across navigation. Inline proposals require accept/reject, undo and stale-buffer protection; voice-only must never propose edits. Follow Pair pointing must not silently retarget a task. Keep settings/research secondary to editor work.

For upstream changes read upstream.lock.json and patch-runtime.mjs/patch-source.mjs; keep both overlay paths coherent. Do not modify downloaded runtime files as the source fix or silently update upstream pins. Run affected tests, build and panel validation. For runtime changes additionally check the patched macOS runtime and integrity when available. Never reload an active human editor without authorization; use a disposable workspace for tests.
