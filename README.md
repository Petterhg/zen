# Zen

Zen is the open-source home of the Pair Code prototype. The app and configuration IDs still use Pair Code to preserve compatibility.

A local Code-OSS foundation for one human and an AI to work together continuously: files on the left, code and tabs in the middle, terminal below, and a quiet pairing companion on the right.

**Current focus: great voice pairing, personal memory and a calm editor UI.** Help the user think, understand and write code. Team collaboration, issue boards and delivery automation are deferred; they are not prerequisites for the core product.

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

In the right workboard, open **Pairing settings** (⚙), choose **Add API Keys** and configure OpenAI plus Groq or Cerebras. Keys are entered in a masked native input and saved with VS Code SecretStorage. For local development, copy `.env.example` to `.env` in your clone and add `OPENAI_API_KEY` plus `GROQ_API_KEY` or `CEREBRAS_API_KEY`. `FIRECRAWL_API_KEY` enables web search and page reading. Restart Pair Code after creating the file. This fixed application file is read only in the local prototype launched with npm start or an extension development host; a repository opened for editing cannot supply provider keys. SecretStorage takes precedence over launch environment variables, which take precedence over this file. No secrets belong in source, workspace settings, or the webview.

Press **Start Pairing** and allow the microphone. The session keeps listening while you type and navigate, until you mute or disconnect. Routine typing and cursor updates are coalesced and held while Pair is speaking; a spoken request refreshes the latest focus immediately. The microphone stays live for natural spoken interruptions. Starting a session requires a click and microphone permission; the app does not silently start capture at launch. Muting keeps the session connected and billable; disconnect ends it.

Try selecting the function in `demo/pairing.ts` and saying “Simplify this without changing the behavior.” You can also type in the panel, or use **⌘⌥I**. Proposed code appears directly in the file as a native multiline inline preview, with **Accept** and **Reject** controls above the target. **⌘Enter** accepts a proposal and ordinary **⌘Z** undoes it. If you edit the file after generation, the proposal becomes stale and cannot overwrite your newer work.

Use the **Inline suggestions** control to choose Off, On request (default), or Automatic. *_⌥\*_ requests an insertion at the cursor; use the editor’s normal Tab acceptance and Escape dismissal. Inline suggestions are canceled when the context changes. Voice-requested insertions and replacements still require explicit proposal acceptance, even with predictions turned off. Empty files are supported: an insertion is anchored at the captured cursor.

On the first file question in an unfamiliar service, Pair automatically gathers a small local orientation: current file, README/manifest/entrypoints and relevant neighbors. It can give one brief “let me get some context” cue, while the foreground starts from the current buffer without waiting for the scout. Narrow current-file questions skip that spoken cue. A single background scout produces a cited service card; known services reuse source-checked cards across sessions. Once you have engaged with code, dwelling on another service for three seconds can prepare its context silently. Typing, cursor movements and slider changes do not start scouts or interrupt speech. Only the compact service card and a numbered current-buffer excerpt reach the main agent, not the researcher’s source collection or conversation. Focused questions first use a small read-only structured answer from captured source; explicitly named symbols can add one scoped definition excerpt. Missing evidence escalates to the full tools. Automatic reasoning skips the remote router only for narrow recognized questions; explicit effort settings remain unchanged. Already-valid results avoid a redundant formatting call. File roles and dependency edges are verified progressively when the question needs them; the agent never claims the entire repo is understood.

For deeper work, say “Explore `services/ner`: trace its entrypoints, extraction flow and callers, and tell me what remains unchecked.” Explicit Explore/Audit requests enter the isolated explorer directly; it starts with a scoped map, exact code-identifier routes and batched seed reads, then follows relevant references outward; the main conversation receives a compact findings report with file/line evidence. Repository exploration is local by default. Ask explicitly for external documentation for web research. `service_context` pages permitted file locators, `research_briefs` retrieves checked cards, and `working_context` retrieves an automatic scout already running. Exploration proposes no edits. Changing the assistance slider preserves ongoing research and waits for quiet playback before updating the speaker. Current source and unsaved buffers override cached interpretations; changed or excluded evidence is suppressed.

The right workboard has **Start new** and, when an eligible saved checkpoint exists, **Continue conversation** at the top, followed by the assistance slider and research. Continue loads the previous request/result checkpoint, rechecks current files and starts the selected conversation mode; it does not replay the complete transcript. Start new clears the repository checkpoint and current conversation, while retaining personal memory preferences. **Voice** keeps the workboard quiet. **Chat / transcript** shows the current conversation with an input at the bottom; switching to Chat disconnects voice and sends text directly to the configured Groq/Cerebras backend. Returning to Voice does not start the microphone. Inline proposals and the assistance slider apply in both modes. The ◐ button switches light/dark; the gear shows or hides provider/API-key configuration, context controls and diagnostics. Errors remain visible even with settings closed. The **Workboard** button at the top right (or **⌘⌥J**) folds and restores the panel without ending voice pairing. Native status-bar mute/end controls remain available while it is folded.

The native title bar contains Zen branding and the Workboard toggle, without repeating the active filename. The duplicate file heading and bottom pairing strip have been removed. macOS traffic-light buttons are hidden; use **File → Close Window**, **Window → Minimize**, **Window → Zoom** and the normal keyboard shortcuts. The header remains draggable. Explorer uses 28px rows, lighter labels and quieter icons/actions. Outline and Timeline start hidden; auxiliary panel tabs start unpinned and remain available through native menus and commands. Subsequent customization is preserved. **Zen: Apply Calm Layout** applies the quieter defaults while keeping the selected theme. `npm start` updates the maintained runtime overlay. Fully quit Zen before restarting.

## Zen workbench design preview

Try the next UI direction with `npm ci` and `npm run prototype:zen`, then open <http://127.0.0.1:4317>. It is a separate browser prototype: calm light/dark styling, a folding file tree/terminal/workboard, editable sample code, local task checkpoints and an issue-to-verification walkthrough. It does not change your running editor.

Light/dark appearance, host/guest controls and configurable specialist-agent examples are included. Memory has no workboard tab. Voice, integrations, terminal results, agent runs and collaboration are simulated. [Research, interaction guide and native implementation plan](docs/zen-workbench.md) distinguish what works locally from the proposed production design.

## Features

These features are implemented in the prototype; this is not a production-readiness checklist. The development runtime currently targets macOS on Apple Silicon.

| Area                | Available today                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor              | File navigator, tabs, terminal, Zen Light/Dark syntax themes, quieter chrome, folding workboard with persistent voice controls, and pinned Code-OSS/VSCodium runtime.                                                        |
| Voice pairing       | Continuous GPT-Live conversation with Groq/Cerebras delegation, mute/disconnect controls, and local session diagnostics.                                                                                                     |
| Conversational help | Source-first short code answers, bounded scoped symbol reads, background service preparation, validated direct results, and escalation to full tools for missing evidence.                                                   |
| Shared context      | Active file, selection, cursor, viewport, unsaved buffers, diagnostics, and recent files.                                                                                                                                    |
| Human control       | Assistance slider from voice-only guidance to larger code proposals; inline suggestions can be off, on request, or automatic.                                                                                                |
| Inline edits        | Native proposals with accept/reject, Command+Enter acceptance, undo, and stale-buffer protection.                                                                                                                            |
| Code pointing       | Spoken explanations can highlight code; Follow Pair controls automatic scrolling.                                                                                                                                            |
| Project exploration | Nonblocking automatic service orientation, checked context reuse across sessions, numbered current buffers, and seeded isolated exploration with scoped search, batched reads and references.                                |
| Semantic retrieval  | One shared local Turso database per computer user, OpenAI small / 768 embeddings, checkout/repository/path/service filters, fresh lexical changes, durable deferred embedding jobs and window-local unsaved-buffer overlays. |
| Indexing progress   | Lexical/embedding phases, stored totals, pending embedding count/deadline, cached chunk reuse and visible errors.                                                                                                            |
| External research   | Optional Firecrawl search/page fetching with documentation displayed in the sidebar; explicit local-only requests disable web tools.                                                                                         |
| Language tooling    | TypeScript/JavaScript support plus Python, BasedPyright, Ruff, ESLint and Prettier integration. Python environment discovery has a known packaging issue; see the roadmap.                                                   |
| Text chat           | Optional Chat / transcript view with bottom composer; direct backend requests, complete cited answers, microphone disconnected, shared tools and inline previews.                                                            |
| Session resume      | Local repository checkpoints, top-level Continue conversation/Start new controls, historical edit outcomes and current-file revalidation. Microphone startup stays manual.                                                   |
| Personal memory     | Automatic backend retention, private inspect/correct/forget/pause controls, source freshness checks and optional authenticated local Hindsight. [Setup and limits](docs/personal-memory.md).                                 |
| Development setup   | Contributor setup, CI, agent instructions, focused skills, and mapper/implementer/reviewer profiles.                                                                                                                         |

## Roadmap

Ordered by current priority, not promised release dates. Completed work moves into Features after it is merged; open PRs remain identified here. Update this section in the same change when user-visible capability or priority changes.

### Core: voice and pair programming

**Goal:** One human and one assistant, working on the code together. The assistant follows what the human is doing, explains at the right level and helps as much or as little as requested.

- [ ] Improve conversational latency, natural interruptions and reliable voice/backend handoffs. Source-first backend answers are implemented; first audible speech and broader phrasing still need evaluation. Keep typing, navigation and assistance changes from interrupting speech; avoid repetitive acknowledgments and progress chatter.
- [ ] Recognize completed human edits from current buffers and diagnostics, and continue without stale instructions.
- [x] Trigger bounded context orientation on unfamiliar-file questions; silently prepare another service after focus dwell and reuse checked cards across sessions.
- [ ] Evaluate scoped retrieval and impact analysis on real coding questions: definitions, references, imports and tests alongside semantic matches. Measure missed evidence and latency, and report incomplete coverage honestly. Native checks cover automatic orientation and warm reuse on a real monorepo; deeper impact analysis remains variable and sometimes slow. Keep evaluating repeated discovery and source-backed interpretation errors; citations alone do not prove correctness.
- [ ] Repair Python environment discovery and keep formatting, linting and inline proposals dependable.
- [ ] Close the local validation loop after edits with diagnostics and explicitly authorized formatter/test execution.

Acceptance: explain → edit → verify on an existing service at voice-only and assisted-edit settings, with correct captured targets, stale-edit rejection and no unwanted interruptions. Separate offline checks from real provider and human voice validation.

### Core: automatic personal memory

- [ ] Add automatic supervision and quality/cost evaluation to the implemented local Hindsight adapter and developer launcher. Hindsight is optional and off until connected; local retention/recall is available now.
- [x] Retain explicit preferences and corrections through backend tools: coding style, conventions, favored approaches, desired assistance and explanation detail. Distinguish personal defaults from repository/service-specific rules.
- [x] Retain source-backed repository/service summaries: structure, responsibilities, entrypoints, dependencies and architectural decisions, with source references and revision-aware freshness checks. Current code wins over stale recollections.
- [ ] Evaluate adaptation to stated topic familiarity in real voice sessions. Retention is implemented; automatic inference of skill level is not.
- [ ] Extend the implemented last-result checkpoint into richer session summaries with decisions, open questions and next steps. Explicit resume now restores the previous request/result and historical edit outcome per repository; it never restarts the microphone or replays edits.
- [x] Provide inspect/correct/forget/pause controls in private Settings/commands. Background indexing runs off the voice path; pairing remains useful while memory is unavailable.

Acceptance: relevant recall after restarting; explicit corrections supersede earlier assumptions; repository boundaries and code freshness are respected; deleted evidence is not immediately relearned; memory improves explanations without slowing or cluttering the conversation. Measure quality, latency, resource use and cost. Local storage does not imply local inference: verify and disclose processing destinations when implementing the adapter. See [the memory design](docs/local-memory-and-shared-tasks.md).

### Core: calm, editor-first UI

- [ ] Refine the native light/dark themes, typography, terminal and inline edits through actual pairing sessions.
- [x] Keep the file tree, editor, terminal and folding workboard focused on the current work. Research and occasional settings belong beside the code; transcripts and typed requests stay in the optional Chat view.
- [ ] Add unobtrusive session resume and useful connection/error states, without requiring a dashboard or task-management workflow.

Native themes, reduced chrome, folding and persistent voice controls are implemented. The broader [browser design study](docs/zen-workbench.md) contains earlier exploratory features; it is not the current feature specification.

### Later: retained ideas, outside the current scope

- [ ] Collaboration with colleagues and shared editable workspaces.
- [ ] Linear/project boards and the GitHub PR → review → merge → CI/CD → cloud verification workflow.
- [ ] Dedicated Reviewer, Delivery and SRE agents and long-running cloud/Sentry monitoring.
- [ ] MCP and additional third-party integrations.
- [x] Separate fresh lexical updates from deferred embeddings, with a persistent queue and manual flush.
- [x] Reuse local source-backed service briefs and invalidate related research after source changes.
- [ ] Parallel exploration, automatic dependency graph construction and retrieval scaling where measurements justify them.
- [ ] Remote development, broader platform support and signed releases/updates.

These ideas remain documented for future consideration. Do not build them as dependencies of voice, personal memory or UI work unless explicitly reprioritized.

This is a local development foundation using the pinned Code-OSS native inline-edit renderer and proposed API. It is not yet a signed production editor. The sidebar shows voice controls, settings, and sources from web research; conversation transcripts and backend summaries stay in the local session trace, available through **Open session trace**. Complete service dependency catalogs, command/test execution, remote development, MCP integrations, and concurrent-edit rebasing are future work. Language-service references provide local impact evidence; they do not establish complete cross-service coverage.

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

Zen uses the new Rust Turso engine (`@tursodatabase/database`, not libSQL) and OpenAI `text-embedding-3-small` at 768 dimensions. Query and corpus vectors share the same embedding namespace. One background service per OS user owns a single database in `~/.zen/code-index/shared-v2/`, shared across Zen windows and launch profiles. Only trusted, explicitly opened workspace roots are registered, and only while Code Index and editor context sharing are enabled. Permitted saved-source chunks go to OpenAI for embedding; the database stays local. Unsaved buffers stay in their window and override shared search results there.

The service starts automatically, deduplicates scans of the same canonical checkout, shares progress and recovers after an owner crash. Authenticated loopback RPC and a private connection token protect the local endpoint. Credentials are held only in connection memory. Closing/revoking the last window for a root cancels its work; the service exits after 60 seconds with no clients. Roots are revalidated and reconciled when reopened. Different worktrees remain separate checkout identities, even when filenames or repository labels match. Search filters on canonical checkout, repository label, directory/path scope, service and language before ranking; each window can query only its registered roots.

Settings show scanning/indexing phases, file progress, current source, stored file/chunk totals for this window's roots and per-pass embedded/reused counts. **Pair Code: Refresh Code Index** reconciles current roots and embeds pending changes now. Saved changes update lexical chunks after a short debounce, shadowing obsolete vectors immediately when staged. Embeddings wait for 30 minutes without changes, with a 60-minute maximum queue age while the root is open (provider failures, cancellation and scheduler load can delay completion). The queue and first/last-change timestamps survive restarts; repeated saves coalesce to the latest source. First-time indexing builds lexical chunks first, then starts embeddings immediately. Deleted files leave search and the pending queue. Unchanged chunks reuse cached vectors. When query embeddings fail, search falls back to lexical retrieval. Ignore/private/generated/realpath/size/deletion checks apply during ingestion and retrieval. Semantic search remains ranked partial evidence, not a complete caller graph; expand parent ranges and verify callers with native search/references. Local index failure never triggers web research.

The first upgraded launch retires the old per-checkout `globalStorage/indexes` caches and rebuilds opened roots from current permitted source. Old rows are not imported. A live legacy owner defers deletion until it closes; missing/dead owner records no longer block migration. Keys, memory, traces, settings and working copies are preserved. The embedding namespace is unchanged, while the shared database schema has its own version. The deferred queue is an additive schema change; existing vectors are retained. RPC protocol 3 prevents older daemons from serving the new client with incompatible behavior. On this upgrade, quit all Zen windows and allow up to 60 seconds for the old owner to exit before reopening. Synthetic tests cover concurrent windows, filters, privacy, migration, deferred-job persistence and packaged-process crash recovery; large-repository latency still needs real-session measurement.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the current direct-to-main workflow, [AGENTS.md](AGENTS.md) for agent instructions, and [agent development](docs/agent-development.md) for skills and specialist roles. MIT licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).

### macOS Keychain prompts during development

The launcher verifies and preserves a valid app signature instead of unconditionally re-signing on each start. Ordinary restarts of the same authorized build keep their signing identity. Changed ad-hoc builds can still trigger “VSCodium Safe Storage” prompts because this runtime retains Electron's internal VSCodium bundle name. Zen never disables Keychain encryption or broadens the item's access list.

For consistent signing across builds, install your own macOS code-signing certificate and launch with `ZEN_CODESIGN_IDENTITY="your certificate name" npm start`. Use the same identity for bootstrap and future launches. A first authorization or a change of signing identity may still prompt. Do not put certificate private keys or Keychain passwords in the repository. A local ad-hoc build is not a notarized release.
