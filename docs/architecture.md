# Foundation architecture

The first runtime is a pinned VSCodium build of Code-OSS, overlaid with product branding and three microphone-policy changes. It installs our local pairing extension into an isolated profile. The launcher uses a normal editor window so Code-OSS provides persistent working-copy backups; extension development windows deliberately lack a disk backup path. This gives us a real editor, terminal, tabs, navigator, language services, normal undo, and extension compatibility immediately.

The pinned Microsoft source checkout lives at `.upstream/code-oss`. `upstream.lock.json` records its exact commit. `npm run patch:source` applies the equivalent readable source changes and copies our compiled extension under `extensions/pair-code`. A full upstream build has not been required to run the first foundation. When moving to source builds, use the Node version in the pinned checkout's `.nvmrc`, follow its own contribution/build instructions, run its development compile, and launch with `scripts/code.sh`. Source builds and installer production are separate milestones.

```text
Code-OSS editor and language tooling
       │ active buffer, selection, diagnostics
       ▼
Pair extension host ─────────── Groq / Cerebras Chat API
  │ keys in SecretStorage        │ JSON answer + optional exact replacement
  │ validates proposals          ▼
  │                       captured-version proposal
  │ SDP exchange                 │ human acceptance → editor.edit → normal undo
  ▼
OpenAI /v1/live/sessions
  ▲                     WebRTC audio + data channel
  └──────────────────────── Pair webview (microphone, playback, settings and research)
```

The OpenAI project key is used only in the extension host to exchange an SDP offer. The renderer receives the SDP answer and session ID. It never receives any provider key. The code backend runs in the extension host, with fixed HTTPS endpoints and validated output. The backend can execute a bounded set of read-only workspace and optional web tools. It cannot execute arbitrary commands or write files.

## Live protocol

- Creation body: `session.model: gpt-live-1`, `session.delegation.type: client`, `transport.type: webrtc`, `transport.sdp`.
- Data-channel label: `oai-events`. Wait for `session.started`; never send `session.start` after HTTP creation.
- Collect exact `session.input_transcript.delta` and `session.output_transcript.delta` fragments. They are not completed turns.
- `session.delegation.created` supplies a delegation ID and timeline offset, not a user prompt. Build backend context from raw transcript fragments up to that offset and the acknowledged editor-context timeline.
- Return concise verified facts with `session.commentary.append`, retaining the delegation ID. Send background editor updates with `session.thinking.append` and `delegation_id: null`.
- Reject late results using application task revisions and session tokens. Speech interruption does not imply cancellation of backend work; newer delegations and explicit Stop cancel the current backend request.
- Muting disables the local microphone track and uses the acknowledged Live mute/unmute events. Disconnect stops local tracks/playback immediately and attempts graceful `session.close` before closing the peer.

## Edits and context

A bounded active-buffer window (normally 12,000 characters, up to 14,000 for a large selection) is shared with absolute cursor/selection offsets, version, visible lines, recent paths, and a small diagnostic list. Read-only workspace tools can retrieve other permitted files on demand. Repository enumeration respects Git ignore rules and an optional `.pairignore`; known credential patterns and realpath escapes are rejected. Known credential-file patterns are excluded; this is a convenience filter, not a comprehensive secret detector. Users can turn off sharing in `pairCode.shareEditorContext`. Starting voice or sending a typed request sends this bounded context to the configured providers.

The backend may produce one exact old/new replacement inside the captured selection, or the bounded file when nothing is selected. Ambiguous or out-of-scope matches fail validation. The resulting proposal records URI, document version, offsets, and old text. Acceptance validates all four again immediately before `editor.edit`. It never auto-saves, formats, runs commands, or silently applies model edits. Format-on-save uses the editor's normal formatter pipeline.

## Microphone boundary

Stock Code-OSS webview iframe policy and Electron media permission handling block capture. The overlay grants microphone policy only when the actual extension ID is `pair-code.pair-code`. Electron checks the real requesting frame's ancestry for that extension ID and grants only audio requests. Camera requests and unrelated webviews remain denied. OS permission and an explicit Start Pairing click are still required. The panel has a strict CSP and uses textContent for model output.

## Next iteration

Measure time to first useful spoken answer, delegation latency, edit accuracy, interruptions, and concentration during real coding. Then improve native multi-line inline proposals, word/hunk acceptance, semantic retrieval, cross-service evidence, model routing, and MCP tools based on observed friction. See [Live behavior](live-behavior.md) for the current protocol decisions and remaining checks. Keep those product modules separate from upstream editor infrastructure.

## Retrieval latency

Workspace text lookup uses native ripgrep with current unsaved-buffer overlays. Batch reads gather up to eight known ranges with bounded I/O concurrency. The explorer has a separate conversation and returns bounded findings and file/line metadata. Session research briefs let later questions reuse those findings without retaining the child's full conversation or source bodies. Their current versions must be verified before edits. The [retrieval roadmap](retrieval-roadmap.md) describes the proposed local hybrid index and optional parallel research workers; these remain separate future stages.
