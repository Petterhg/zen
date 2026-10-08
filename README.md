# Zen

Zen is the open-source home of the Pair Code prototype. The app and configuration IDs still use Pair Code to preserve compatibility.

A local Code-OSS foundation for a human and an AI to work together continuously: files on the left, code and tabs in the middle, terminal below, and a quiet pairing companion on the right.

GPT-Live 1 (`gpt-live-1`) handles the full-duplex voice conversation. Client delegation connects it to Groq or Cerebras for code reasoning. The default backend is `qwen/qwen3.8-27b` on Groq, with `qwen-3.8-27b` on Cerebras. Both are configurable. Backend reasoning defaults to `auto` through OpenAI Decisions, with a safe fallback; project exploration uses at least `medium` and inline completion uses `none`.

## Run

This first development runtime targets macOS Apple Silicon and Node 22+.

```sh
git clone https://github.com/Petterhg/zen.git
cd zen
nvm use
npm ci
npm run bootstrap
npm start
```

Open another repository with `npm start -- /absolute/path/to/repository`. The runtime, settings, extensions, and data live inside this project; your existing editor installation and settings are separate.

In the right panel, choose **Add API Keys** and configure OpenAI plus Groq or Cerebras. Keys are entered in a masked native input and saved with VS Code SecretStorage. For local development, copy `.env.example` to `.env` in your clone and add `OPENAI_API_KEY` plus `GROQ_API_KEY` or `CEREBRAS_API_KEY`. `FIRECRAWL_API_KEY` enables web search and page reading. Restart Pair Code after creating the file. This fixed application file is read only in the local prototype launched with npm start or an extension development host; a repository opened for editing cannot supply provider keys. SecretStorage takes precedence over launch environment variables, which take precedence over this file. No secrets belong in source, workspace settings, or the webview.

Press **Start Pairing** and allow the microphone. The session keeps listening while you type and navigate, until you mute or disconnect. Routine typing and cursor updates are coalesced and held while Pair is speaking; a spoken request refreshes the latest focus immediately. The microphone stays live for natural spoken interruptions. Starting a session requires a click and microphone permission; the app does not silently start capture at launch. Muting keeps the session connected and billable; disconnect ends it.

Try selecting the function in `demo/pairing.ts` and saying “Simplify this without changing the behavior.” You can also type in the panel, or use **⌘⌥I**. Proposed code appears directly in the file as a native multiline inline preview, with **Accept** and **Reject** controls above the target. **⌘Enter** accepts a proposal and ordinary **⌘Z** undoes it. If you edit the file after generation, the proposal becomes stale and cannot overwrite your newer work.

Use the **Inline suggestions** control to choose Off, On request (default), or Automatic. *_⌥\*_ requests an insertion at the cursor; use the editor’s normal Tab acceptance and Escape dismissal. Inline suggestions are canceled when the context changes. Voice-requested insertions and replacements still require explicit proposal acceptance, even with predictions turned off. Empty files are supported: an insertion is anchored at the captured cursor.

To explore an existing service, say “Explore `services/ner`: trace its entrypoints, extraction flow and callers, and tell me what remains unchecked.” Pair delegates research to a separate context. The explorer starts with that directory and follows relevant references outward; the main conversation receives a compact findings report with file/line evidence. Repository exploration uses local tools by default. Ask explicitly for external documentation when you also want web research. Exploration proposes no edits; request an implementation separately. Known files can be read in batches, and native text search overlays unsaved buffers. Compact explorer findings stay available within the voice session and are marked stale after edits. Changing the assistance slider preserves ongoing research and waits for quiet playback before updating the speaker; the new local setting applies immediately.

## Zen workbench design preview

Try the next UI direction with `npm ci` and `npm run prototype:zen`, then open <http://127.0.0.1:4317>. It is a separate browser prototype: calm light/dark styling, a folding file tree/terminal/workboard, editable sample code, local task checkpoints and an issue-to-verification walkthrough. It does not change your running editor.

Voice, integrations, terminal results and collaboration are simulated. [Research, interaction guide and native implementation plan](docs/zen-workbench.md) distinguish what works locally from the proposed production design.

## Features

These features are implemented in the prototype; this is not a production-readiness checklist. The development runtime currently targets macOS on Apple Silicon.

| Area                | Available today                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor              | File navigator, tabs, terminal, minimal Graphite layout, and pinned Code-OSS/VSCodium runtime.                                                                             |
| Voice pairing       | Continuous GPT-Live conversation with Groq/Cerebras delegation, mute/disconnect controls, and local session diagnostics.                                                   |
| Shared context      | Active file, selection, cursor, viewport, unsaved buffers, diagnostics, and recent files.                                                                                  |
| Human control       | Assistance slider from voice-only guidance to larger code proposals; inline suggestions can be off, on request, or automatic.                                              |
| Inline edits        | Native proposals with accept/reject, Command+Enter acceptance, undo, and stale-buffer protection.                                                                          |
| Code pointing       | Spoken explanations can highlight code; Follow Pair controls automatic scrolling.                                                                                          |
| Project exploration | Isolated read-only researcher, scoped file/text search, batched reads, and language-service references.                                                                    |
| Semantic retrieval  | Local Turso index, OpenAI small embeddings at 768 dimensions, hybrid search, service/repository filters, incremental updates, and unsaved-buffer handling.                 |
| Indexing progress   | Scanning/indexing phases, files checked, active file, embedded/reused chunk counts, update time, visible errors and retry guidance. |
| External research   | Optional Firecrawl search/page fetching with documentation displayed in the sidebar.                                                                                       |
| Language tooling    | TypeScript/JavaScript support plus Python, BasedPyright, Ruff, ESLint and Prettier integration. Python environment discovery has a known packaging issue; see the roadmap. |
| Collaboration       | Contributor setup, CI, agent instructions, focused skills, and mapper/implementer/reviewer profiles.                                                                       |

## Roadmap

Ordered by current priority, not promised release dates. Completed work moves into Features after it is merged; open PRs remain identified here. Update this section in the same change when user-visible capability or priority changes.

### Next milestone: explain → edit → verify

**Goal:** Select a function, ask for an explanation, make a guided change, and have the assistant notice and help verify it. The human stays in control of how much code the assistant writes.

- [ ] **Repair Python environment discovery.** Bundle a working `pet` helper for the supported platform and verify it during setup. Selecting an existing interpreter must not mask broken environment discovery.
- [ ] **Evaluate retrieval on real coding questions.** Measure relevant results, missed evidence, lookup latency and backend rounds for service explanations and impact questions. Keep private evaluation content out of public fixtures.
- [ ] **Make coaching respond to human edits.** Recognize a completed step, use current buffers and diagnostics, and continue without stale instructions, repeated acknowledgments or interrupted speech.
- [ ] **Strengthen impact analysis.** Combine semantic matches with definitions, references, imports and relevant tests; distinguish verified dependencies from inference and incomplete coverage.
- [ ] **Close the validation loop.** After human edits or accepted proposals, inspect diagnostics and support explicitly authorized formatter/test execution with concise, truthful results.

Milestone acceptance: demonstrate this interaction on an existing service at voice-only and assisted-edit settings; preserve the requested target through tab changes, reject stale edits, keep typing/slider updates from interrupting speech, and report what was actually verified. Record offline checks separately from real provider and human voice validation.

### Task workspace and collaboration

- [ ] Bring the [Zen workbench design study](docs/zen-workbench.md) into the native editor: calm theme, reduced chrome, folding workboard and persistent voice controls. The browser example is an interaction prototype only.
- [ ] Persist task-linked session checkpoints, decisions and checkout context; resume after restart without automatically starting the microphone.
- [ ] Connect Linear issues to GitHub PR/review/CI evidence and AWS/GCP deployment/integration results, tied to the exact revision and explicit action permissions.
- [ ] Add shared task rooms, then concurrent editing and coordinated multi-person voice pairing with the AI. Independent navigation and opt-in following come first.

### Proposed: durable project and personal memory

- [ ] **Pilot optional memory behind a provider adapter**, with [Hindsight](https://github.com/vectorize-io/hindsight) as a candidate rather than a committed dependency. Start with explicit “remember this,” project decisions with rationale, and a short session-resume brief. No memory service is implemented or enabled yet.

Potential implementation:

- Keep current source retrieval in Turso and live cursor/buffer state in the editor. Durable memory holds preferences, decisions, verified findings and unfinished work, with separate personal and shared project scopes.
- Call the memory provider from the extension host through its TypeScript client or HTTP API. Recall relevant evidence alongside code search; retain compact outcome records asynchronously. Keep memory failures and slow reflection off the speech-critical path.
- Store source/commit references and distinguish proposed, accepted and verified outcomes. Revalidate code-related memories against current files; current user instructions and repository rules take precedence over inferred memories.
- Provide inspect, correct, forget and disable controls. Choose storage/inference destinations explicitly; local hosting does not imply local model inference. Do not ingest raw transcripts or private code automatically as part of the pilot.
- Evaluate a separately hosted Hindsight service first; it has its own database/model dependencies and does not replace our embedded Turso index. Background project summaries are a possible later optimization.

Acceptance: a new session recalls a relevant decision, respects a correction/deletion, avoids cross-project or cross-user leakage, and remains usable when memory is unavailable. Measure recall usefulness, added latency and model cost before making it a default feature.

### Later

- [ ] Extend the memory pilot to maintained project summaries with source/version tracking and invalidation.
- [ ] MCP and third-party tool integrations with clear permissions.
- [ ] Parallel exploration for broad, independent research where measurements justify the added complexity.
- [ ] Retrieval scaling and additional language-aware chunking based on evaluation results.
- [ ] Better concurrent-edit reconciliation and broader workspace/remote-development support.
- [ ] Additional desktop platforms and a signed release/update pipeline.

This is a local development foundation using the pinned Code-OSS native inline-edit renderer and proposed API. It is not yet a signed production editor. The sidebar shows voice controls, settings, and sources from web research; conversation transcripts and backend summaries stay in the local session trace, available through **Open session trace**. Durable project knowledge, service dependency catalogs, command/test execution, remote development, MCP integrations, and concurrent-edit rebasing are future work. Language-service references provide local impact evidence; they do not establish complete cross-service coverage.

Cerebras, Firecrawl, and a synthetic-audio GPT-Live → Cerebras → spoken-response session have passed live checks on this machine. Groq has not been live-tested. Real microphone/echo behavior, natural interruptions, and the subjective pairing feel still need a human session; see the validation record in [Live behavior](docs/live-behavior.md).

## Validate and develop

```sh
npm run check
npm run lint
npm run build
npm test
npx playwright install chromium
npm run test:panel # Simulated transport; no API calls
```

For a smoke check of the running sidebar, launch with `npm start -- --remote-debugging-port=9328 --remote-debugging-address=127.0.0.1`, then run `npm run test:ui`. With keys configured, this makes one read-only backend request about the demo file; otherwise it checks the missing-key path. Normal launches expose no debugging port.

`extension/src/` owns the pairing logic; `extension/media/` owns the panel. `scripts/patch-runtime.mjs` contains the small development-runtime changes. `npm run patch:source` mirrors those changes into the pinned Code-OSS source and copies the pairing module as a built-in extension. See [architecture](docs/architecture.md) and the [Live behavior contract](docs/live-behavior.md).

Local development sessions now write JSONL diagnostics containing conversation transcripts, tool metadata, token usage, and errors. Use **Pair Code: Open Session Trace** or the **Pair Code Diagnostics** output channel. Keys, full source snapshots, raw tool bodies, and private reasoning are excluded; logs remain in the isolated `.runtime` profile. Disable new writes with `pairCode.traceEnabled`. Do not attach unredacted traces to public issues.

## Official references

- [GPT-Live model](https://developers.openai.com/api/docs/models/gpt-live-1)
- [Client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [WebRTC transport](https://developers.openai.com/api/docs/guides/voice-webrtc)
- [Session events](https://developers.openai.com/api/docs/guides/live-conversations)
- [Groq Chat API](https://console.groq.com/docs/api-reference)
- [Cerebras Chat API](https://inference-docs.cerebras.ai/api-reference/chat-completions)
- [Code-OSS](https://github.com/microsoft/vscode), [VSCodium](https://github.com/VSCodium/vscodium)

Code-OSS is MIT-licensed. VSCodium's bundled third-party notices remain in the runtime. The modified runtime is ad-hoc signed solely for local development. Production distribution requires its own signing, update pipeline, and dependency/license review.

## Local code index

Version 0.2.0 adds the new Rust Turso engine (`@tursodatabase/database`, not libSQL) and OpenAI `text-embedding-3-small` at 768 dimensions. Repository and query vectors always use the same configuration. The background index starts in trusted workspaces when **Pair Code: Index Enabled**, editor context sharing, and an OpenAI key are available. Permitted source chunks are sent to OpenAI for embedding; the database and cached vectors stay in the extension's local global-storage directory, separately for each checkout. Disable Index Enabled to stop this feature.

The settings sidebar shows scanning/indexing phases, files checked in the current repository, the active file, per-pass embedded/reused chunk counts, update time, and visible errors. The file progress counts inspected candidates; ready shows the indexed file count. There is also a refresh button; **Pair Code: Refresh Code Index** also reconciles the workspace. Ordinary edits are debounced and only changed embedding inputs are sent again. Moves can reuse cached chunks when their full embedding input is unchanged. Ignore rules, private paths, generated-file exclusions, source-size limits, deletions, and current source hashes are checked. Unsaved buffers override old results while background indexing catches up.

The main assistant and isolated explorer can use `search_code` with repository, service, directory, and language filters, and `index_status` to discover coverage and service names. Retrieval combines filtered exact cosine search with lexical candidates. Functions and methods are parsed for Python, JavaScript and TypeScript; large declarations and other languages use bounded text chunks. Results include parent ranges for targeted reads. Manifest directories and conventional service/package directories determine service labels. Symbol references and native text search still verify dependencies: vectors do not establish a complete call graph.

Initial indexing runs in the background and results can be partial. One editor process owns a checkout's index at a time; another window can still use native search. Index schemas/model dimensions are versioned so incompatible vectors cannot mix. This version has synthetic live OpenAI/Turso validation, but large-monorepo latency and retrieval quality still need measurement in real pairing sessions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the current direct-to-main workflow, [AGENTS.md](AGENTS.md) for agent instructions, and [agent development](docs/agent-development.md) for skills and specialist roles. MIT licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).
