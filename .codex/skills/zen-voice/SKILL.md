---
name: zen-voice
description: Implement or debug Zen voice transport, speaker context, backend delegation, interruption and session lifecycle behavior.
---

# zen-voice

Read docs/live-behavior.md, then trace panel.js → live-protocol.ts → extension.ts/backend.ts for the affected event. Distinguish editor telemetry from spoken turns, backend task identity from current focus, and transport delivery from acknowledged context. Preserve session-generation guards, mute matching, cancellation, current request target, and no source/reasoning leakage into speech. Do not solve output exhaustion by truncating JSON/code or rejecting legitimate reasoning: preserve structured recovery and bounded speech summaries. Verify changing GPT-Live/Decisions schemas in official OpenAI docs.

Use context-pacing, code-pointing, backend-recovery and task-policy tests as applicable, plus test:panel for playback changes. Exercise typing during speech, slider changes, spoken interruption, reconnect and stale completion. An offline fake WebRTC check is not microphone validation. Summarize the exact lifecycle fixed and what remains for a human voice session.
