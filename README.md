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

To explore an existing service, say “Explore `services/ner`: trace its entrypoints, extraction flow and callers, and tell me what remains unchecked.” Pair delegates research to a separate context. The explorer starts with that directory and follows relevant references outward; the main conversation receives a compact findings report with file/line evidence. Repository exploration uses local tools by default. Ask explicitly for external documentation when you also want web research. Exploration proposes no edits; request an implementation separately. Known files can be read in batches, and native text search overlays unsaved buffers. Compact explorer findings stay available within the voice session and are marked stale after edits. Changing the assistance slider preserves ongoing research and waits for quiet playback before updating the speaker; the new local setting applies immediately.

Use **Zen: Switch Light / Dark** from the command palette or the ◐ button in the workboard. **⌘⌥J** folds and restores the workboard without ending voice pairing. The compact workboard keeps current-file context and the assistance slider visible; settings and index details stay collapsed. The latest request appears as a compact Intent section when backend work begins, without a transcript feed. The pairing card appears above the working agreement; index progress and errors occupy a compact bottom strip. Research appears when sources arrive. Index progress and errors remain visible. During voice pairing, the native status bar retains mute/unmute and end-session controls even with the workboard folded. **Zen: Apply Calm Layout** applies the quieter layout to an existing profile while keeping its selected theme. New profiles use Zen Dark; custom appearance settings are preserved. `npm start` updates the maintained native shell in your existing runtime: a real file heading, inset Monaco surface, underlined tabs, reference monospace typography and a taller title bar. The first launch with this layout resets pane proportions to a narrow file tree, 325px companion and shallow terminal; subsequent manual resizing is preserved. The exact former application font default is migrated; custom fonts are preserved. Quit Zen before restarting.

## Zen workbench design preview

Try the next UI direction with `npm ci` and `npm run prototype:zen`, then open <http://127.0.0.1:4317>. It is a separate browser prototype: calm light/dark styling, a folding file tree/terminal/workboard, editable sample code, local task checkpoints and an issue-to-verification walkthrough. It does not change your running editor.

Light/dark appearance, host/guest controls and configurable specialist-agent examples are included. Memory has no workboard tab. Voice, integrations, terminal results, agent runs and collaboration are simulated. [Research, interaction guide and native implementation plan](docs/zen-workbench.md) distinguish what works locally from the proposed production design.

## Features

These features are implemented in the prototype; this is not a production-readiness checklist. The development runtime currently targets macOS on Apple Silicon.

| Area                | Available today                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor              | File navigator, tabs, terminal, Zen Light/Dark syntax themes, quieter chrome, folding workboard with persistent voice controls, and pinned Code-OSS/VSCodium runtime.                        |
| Voice pairing       | Continuous GPT-Live conversation with Groq/Cerebras delegation, mute/disconnect controls, and local session diagnostics.                                                                     |
| Shared context      | Active file, selection, cursor, viewport, unsaved buffers, diagnostics, and recent files.                                                                                                    |
| Human control       | Assistance slider from voice-only guidance to larger code proposals; inline suggestions can be off, on request, or automatic.                                                                |
| Inline edits        | Native proposals with accept/reject, Command+Enter acceptance, undo, and stale-buffer protection.                                                                                            |
| Code pointing       | Spoken explanations can highlight code; Follow Pair controls automatic scrolling.                                                                                                            |
| Project exploration | Isolated read-only researcher, scoped file/text search, batched reads, and language-service references.                                                                                      |
| Semantic retrieval  | Local Turso index, OpenAI small embeddings at 768 dimensions, hybrid search, service/repository filters, incremental updates, and unsaved-buffer handling.                                   |
| Indexing progress   | Scanning/indexing phases, files checked, active file, embedded/reused chunk counts, update time, visible errors and retry guidance.                                                          |
| External research   | Optional Firecrawl search/page fetching with documentation displayed in the sidebar.                                                                                                         |
| Language tooling    | TypeScript/JavaScript support plus Python, BasedPyright, Ruff, ESLint and Prettier integration. Python environment discovery has a known packaging issue; see the roadmap.                   |
| Session resume      | Local repository checkpoints, explicit Resume/Start fresh controls, historical edit outcomes and current-file revalidation. Microphone startup stays manual.                                 |
| Personal memory     | Automatic backend retention, private inspect/correct/forget/pause controls, source freshness checks and optional authenticated local Hindsight. [Setup and limits](docs/personal-memory.md). |
| Development setup   | Contributor setup, CI, agent instructions, focused skills, and mapper/implementer/reviewer profiles.                                                                                         |

## Roadmap

Ordered by current priority, not promised release dates. Completed work moves into Features after it is merged; open PRs remain identified here. Update this section in the same change when user-visible capability or priority changes.

### Core: voice and pair programming

**Goal:** One human and one assistant, working on the code together. The assistant follows what the human is doing, explains at the right level and helps as much or as little as requested.

- [ ] Improve conversational latency, natural interruptions and reliable voice/backend handoffs. Keep typing, navigation and assistance changes from interrupting speech; avoid repetitive acknowledgments and progress chatter.
- [ ] Recognize completed human edits from current buffers and diagnostics, and continue without stale instructions.
- [ ] Evaluate scoped retrieval and impact analysis on real coding questions: definitions, references, imports and tests alongside semantic matches. Measure missed evidence and latency, and report incomplete coverage honestly.
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
- [x] Keep the file tree, editor, terminal and folding workboard focused on the current work. Research and occasional settings belong beside the code; transcripts stay optional diagnostics.
- [ ] Add unobtrusive session resume and useful connection/error states, without requiring a dashboard or task-management workflow.

Native themes, reduced chrome, folding and persistent voice controls are implemented. The broader [browser design study](docs/zen-workbench.md) contains earlier exploratory features; it is not the current feature specification.

### Later: retained ideas, outside the current scope

- [ ] Collaboration with colleagues and shared editable workspaces.
- [ ] Linear/project boards and the GitHub PR → review → merge → CI/CD → cloud verification workflow.
- [ ] Dedicated Reviewer, Delivery and SRE agents and long-running cloud/Sentry monitoring.
- [ ] MCP and additional third-party integrations.
- [ ] Parallel exploration and retrieval scaling where measurements justify them.
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

Version 0.2.0 adds the new Rust Turso engine (`@tursodatabase/database`, not libSQL) and OpenAI `text-embedding-3-small` at 768 dimensions. Repository and query vectors always use the same configuration. The background index starts in trusted workspaces when **Pair Code: Index Enabled**, editor context sharing, and an OpenAI key are available. Permitted source chunks are sent to OpenAI for embedding; the database and cached vectors stay in the extension's local global-storage directory, separately for each checkout. Disable Index Enabled to stop this feature.

The settings sidebar shows scanning/indexing phases, files checked in the current repository, the active file, per-pass embedded/reused chunk counts, update time, and visible errors. The file progress counts inspected candidates; ready shows the indexed file count. There is also a refresh button; **Pair Code: Refresh Code Index** also reconciles the workspace. Ordinary edits are debounced and only changed embedding inputs are sent again. Moves can reuse cached chunks when their full embedding input is unchanged. Ignore rules, private paths, generated-file exclusions, source-size limits, deletions, and current source hashes are checked. Unsaved buffers override old results while background indexing catches up.

The main assistant and isolated explorer can use `search_code` with repository, service, directory, and language filters, and `index_status` to discover coverage and service names. Retrieval combines filtered exact cosine search with lexical candidates. Functions and methods are parsed for Python, JavaScript and TypeScript; large declarations and other languages use bounded text chunks. Results include parent ranges for targeted reads. Manifest directories and conventional service/package directories determine service labels. Symbol references and native text search still verify dependencies: vectors do not establish a complete call graph.

Initial indexing runs in the background and results can be partial. One editor process owns a checkout's index at a time; another window can still use native search. Index schemas/model dimensions are versioned so incompatible vectors cannot mix. This version has synthetic live OpenAI/Turso validation, but large-monorepo latency and retrieval quality still need measurement in real pairing sessions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the current direct-to-main workflow, [AGENTS.md](AGENTS.md) for agent instructions, and [agent development](docs/agent-development.md) for skills and specialist roles. MIT licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).

### macOS Keychain prompts during development

The launcher verifies and preserves a valid app signature instead of unconditionally re-signing on each start. Ordinary restarts of the same authorized build keep their signing identity. Changed ad-hoc builds can still trigger “VSCodium Safe Storage” prompts because this runtime retains Electron's internal VSCodium bundle name. Zen never disables Keychain encryption or broadens the item's access list.

For consistent signing across builds, install your own macOS code-signing certificate and launch with `ZEN_CODESIGN_IDENTITY="your certificate name" npm start`. Use the same identity for bootstrap and future launches. A first authorization or a change of signing identity may still prompt. Do not put certificate private keys or Keychain passwords in the repository. A local ad-hoc build is not a notarized release.
