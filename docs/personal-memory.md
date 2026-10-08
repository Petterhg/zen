# Personal memory: first implementation

Zen quietly retains useful preferences, explicit corrections, stated topic familiarity and source-backed project summaries through backend tools. Personal defaults follow the local editor profile. Project records are scoped to the real path of a repository checkout; separate clones/worktrees currently have separate project scopes. There is no Memory tab.

## Use it

Open **Pairing settings → Personal memory**, or **Zen: Manage Personal Memory** in the command palette. Inspect evidence, correct, forget, add a preference, pause or check status there. Local retention/keyword recall is enabled by default in trusted workspaces while context sharing is enabled. Try “I prefer short functions and concise explanations,” then inspect the retained preference. Automatic retention depends on the backend choosing its memory tool; an explicit **Add a preference** control is also available.

Relevant records are supplied as reference data to backend requests and voice-session startup. Current requests, repository conventions and current code take precedence. Routine memory work never appends speaking instructions or restarts/interferes with an active voice turn. A privacy action (pause, correction or forgetting) deliberately ends the current voice session and clears in-memory conversation context so previously injected recollections are not reused. Start Pairing again afterwards.

## Optional local Hindsight

Install [uv](https://docs.astral.sh/uv/), then from the Zen checkout:

```sh
npm run memory:serve -- /absolute/path/to/your/existing/.env
```

Alternatively supply `OPENAI_API_KEY` and `GROQ_API_KEY` or `CEREBRAS_API_KEY` in the launch environment and omit the file argument. The explicit developer command reads that file; the editor does not load credentials from an arbitrary open repository. If uvx is not on PATH, set `UVX_PATH` to its executable.

The launcher pins Hindsight 0.10.2, binds its API to `127.0.0.1:9077`, and starts its embedded local PostgreSQL database named `zen-personal-memory`. First launch downloads the runtime. Keep the terminal open; Ctrl+C stops it. It does not run a hosted Hindsight service or start a dashboard. This is a developer launcher, not yet an automatically supervised editor service.

In **Personal memory**, choose **Connect local Hindsight**. Zen imports the local connection token into SecretStorage. **Configure local Hindsight** supports an independently started authenticated instance. **Memory status** shows the local record count, queued index work and failures. Hindsight being configured does not prove indexing has completed. Stopping it leaves local recall working; pending work retries every 15 seconds while memory is enabled. Pause stops both recall and synchronization, including queued remote deletions.

The launcher uses Groq `qwen/qwen3.8-27b` if its key is available, otherwise Cerebras `qwen-3.8-27b`. It uses OpenAI `text-embedding-3-small` at 768 dimensions, with RRF ranking rather than a downloaded neural reranker. **Storage is local; processing is hosted.** Selected memory summaries, supporting evidence and recall queries reach these configured providers. Recalled records also reach the configured pairing/voice models. This choice is independent of the existing Turso code index; no vector spaces are mixed.

`~/.config/zen/hindsight/connection.json` stores the local endpoint/token with owner-only permissions. The launcher passes provider keys through the child environment, never command arguments or that connection file. Hindsight maintains its own pg0 storage under the OS account. Protect local backups and diagnostics as private data.

For a manual provider test, start the service then run:

```sh
node --import tsx scripts/memory-smoke.mjs
```

This sends only synthetic preferences, checks authentication/retention/recall/correction/document deletion, and cleans its synthetic documents. It is deliberately excluded from the offline test suite.

## Data and failure behavior

The authoritative journal is `personal-memory/memory-v1.json` under the extension's local `globalStorageUri`, outside project files. It is owner-readable/writable, atomically replaced and contains records, source hashes, indexing jobs and forgotten-evidence hashes. This is not an encrypted database. One extension process owns the journal; another window sharing the same profile continues pairing without memory until the owner closes. A stale process lock is recovered on the next open; a leftover recovery lock requires inspection.

Personal preference/familiarity writes require an exact quote from the latest human message. Project summaries require current source quotes and file hashes, and pass workspace ignore/private-path/realpath checks. Retrieval rechecks hashes against current buffers and excludes stale, unavailable or newly private files. A summary supported by a source quote is still a model interpretation, not proof of runtime behavior. Secret-pattern checks are defense in depth, not a guarantee of perfect secret detection.

Corrections replace the current canonical record and use a new immutable Hindsight document ID. Forget immediately removes the record from future local recall, blocks automatic reuse of its key and exact evidence, and queues remote document deletion. Already submitted retention is reconciled before deletion. A stopped/unavailable server means remote deletion is still pending; existing diagnostic traces/backups are separate. A manual restore is explicit and does not remove automatic-relearning tombstones. Failed Hindsight extraction is visible in status and needs investigation in the local service; it cannot make the coding task fail.

Semantic recall ranks only current canonical document IDs. Zen never forwards arbitrary generated Hindsight observations as instructions or authoritative knowledge. Normal delegation uses immediate local recall and warms semantic ranking asynchronously; the backend can explicitly use `recall_pairing_context` to wait for relevant semantic results. Requests have a five-second bound and fall back locally. Retention/indexing stays off the speech path.

## Still planned

Resumable session checkpoints, service-level scope identities across checkouts, multi-window memory ownership, automatic daemon supervision, broader natural-language correction/deletion, quality/cost measurement, and human voice-session evaluation remain follow-up work. There is no cross-device sync, colleague access, issue-board dependency or inferred global skill score.

API contracts: [Hindsight retain](https://hindsight.vectorize.io/developer/api/retain), [recall](https://hindsight.vectorize.io/developer/api/recall), [local authentication](https://hindsight.vectorize.io/developer/extensions), [configuration](https://hindsight.vectorize.io/developer/configuration), and [OpenAI Live client delegation](https://developers.openai.com/api/docs/guides/live-delegation).

## Validation record (2026-10-08)

The offline suite covers journal restart, corrections, failed-write rollback, evidence tombstones, repository separation, ignored paths, dirty-buffer invalidation, pause, operation polling and bounded voice-startup reference serialization. A live synthetic run against local Hindsight 0.10.2 passed authenticated retention, semantic recall, correction and confirmed document deletion using the existing Cerebras and OpenAI keys. No private source or transcripts were used. Hindsight's operation lookup returns HTTP 200 with `status: "not_found"` for a new operation; the adapter handles that as a submission opportunity, not a pending job. Human microphone behavior and the quality of automatic preference collection still need a pairing session.
