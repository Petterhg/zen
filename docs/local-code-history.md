# Local code history: first implementation slice

This is the first slice of the [conversation history plan](conversation-history-plan.md), not a complete replacement for Git blame or a shared provenance system.

## Use it

Open a trusted Git repository, keep **Share editor context** enabled, and run **Zen: Enable Local Code History** from the command palette. This explicitly enables local recording for that checkout on this computer. It creates `.zen/project.json` containing a stable, random repository ID. Commit that file if clones should inherit the identity; initialization does not commit it, change remotes or install hooks. Unborn Git repositories are supported. Only the first workspace folder is initialized in this release.

**Zen: Inspect Local Code History** opens a read-only virtual JSON document showing capture status, recorded requests, proposal explanations, acceptance/save events and current-session character ranges. It is an initial diagnostic inspector, not the eventual inline “why” UI. Virtual documents avoid normal untitled-file backup persistence. Changing context-sharing or workspace ignore files clears an open inspector; reopening revalidates current path access.

**Zen: Stop Local Code History Recording** disables automatic recording for the checkout. It retains encrypted journals and their keys. Enabling again adopts the existing repository ID and creates another writer stream. An enabled checkout resumes on a later editor start; adopting a cloned project file alone does not enable recording.

## What is captured

- Baselines and text changes of open permitted file buffers. Editor-reported `cursor/type` operations are labeled human typing. This is a local editor-origin claim, not authenticated proof of a physical person pressing keys. Paste, completion, formatting, undo/redo and unsupported sources remain unknown in this first release.
- Foreground host requests with input, target version/selection, conversation mode, assistance level, provider/model and requested effort. These are host observations, not the exact assembled provider request or effective reasoning setting.
- Single-file proposal creation and stated explanation, linked by host-created IDs to the originating request when available. Preview API calls can have no request; their missing link stays visible.
- Verified acceptance of the complete expected buffer, and saving as a separate event. A text mutation alone never proves acceptance or saving. AI attribution requires the explicit proposal/application link, not a recently active conversation.
- An independent pure reducer reconstructs current-session text and character origins. Later edits retain unaffected origins. Offsets use UTF-16 to match the editor. Baselines import existing text without claiming its author.

Voice-only conversations that do not delegate to the foreground backend are not captured yet. No hidden chain of thought is captured or inferred. The proposal explanation is a stated rationale. Voice playback, unedited answers, complete provider messages/retries, filesystem edits, worker runs and multi-file task integrations are not captured yet. Normal typing/navigation/slider behavior and explicit preview acceptance are unchanged. Recording does not send evidence to a provider or start the microphone.

## Storage and boundaries

History lives separately from the code index under the extension's global storage, `history/<repositoryId>/<replicaId>.db`. It uses the installed new Turso engine. Each editor session has a separate writer journal and random AES-256-GCM key held by VS Code SecretStorage. Reading aggregates journals; replay processes each replica independently because editor version numbers are local. This deliberately replaces the plan's initial single-writer database shape until a dedicated history service is justified.

Event payloads, including paths, source and requests, are encrypted. Directory/file permissions are restricted. SecretStorage availability and readback are required; there is no plaintext fallback. Hash chaining detects middle-record deletion or reordering, and authenticated encryption detects altered/swapped payloads. This is not signed remote provenance and cannot prove that an entire journal or its tail was not deleted. A backup of databases alone cannot recover missing encryption keys.

Capture and inspection honor trust, shared-context state, fresh ignore rules, private paths and realpath policy. File symlinks and symlink components inside the repository are excluded. Paused-period edits receive a new baseline when observation resumes; they are not silently attributed. Old bodies remain encrypted locally after recording stops or a path is ignored; this slice has no erasure/export interface.

Human editing continues if storage fails. A visible history-gap status reports recording failures; proposals requiring a new durable history record fail rather than pretend they were recorded. The current implementation stores snapshots and patches together and stops on an event exceeding 4 MiB. It has no storage quota, compact object store or crash recovery for partially observed acceptance yet. There can be an unflushed tail at process termination. These are declared coverage gaps, not complete history.

## Verification

`node --import tsx --test test/history.test.ts` exercises real Turso persistence, simultaneous separate writers, encrypted bytes, missing keys, corrupt/missing events, oversize failure, initialization and mixed-origin range replay with an independent character oracle.

The native fixture has passed keyboard-origin capture, request-linked acceptance, saving, range attribution, recorder reopening and ignore revocation. On macOS with a bootstrapped runtime, `npm run test:history:native` opens a separate editor profile and synthetic repository. It uses the production recorder and native document-change events. The test vault is an in-memory fixture: native adapter/engine checks do not prove OS Keychain behavior. It does not restart the user's active editor or send code to providers. Full process restart with OS keys and human microphone guidance remain separate validation work.

Next: capture provider invocation/result boundaries and worker integration; add persisted causal links and recoverable apply transactions; then Git mappings and an inline “why” view. Range lineage across undo, reopen/external changes, concurrent edits and Git transformations must be proven before advertising complete blame.
