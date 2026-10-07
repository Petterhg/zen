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

## What this foundation contains

- An isolated, lightly branded VSCodium runtime built from Code-OSS; pinned upstream source checkout and repeatable source overlays.
- A minimal default layout and restrained Graphite theme.
- Continuous GPT-Live WebRTC integration using the documented `/v1/live/sessions` API and client delegation.
- Groq/Cerebras Qwen adapters with pageable tools, cancellation, failure recovery, and manual proposal acceptance.
- Cursor, selection, viewport, unsaved-buffer, diagnostics, and recent-file context; acknowledged voice-context tracking.
- Spoken code pointing with a separate editor highlight and a Follow Pair scrolling toggle. Normal editor windows preserve unsaved buffers across reloads.
- Service-scoped file discovery and search, direct unsaved-buffer reads, language-service definitions/references/calls, diagnostics, and Git diff. An isolated read-only explorer returns compact findings. Optional Firecrawl web search/page fetch.
- Toggleable native inline insertion suggestions.
- A scoped microphone permission patch: our panel may request audio; other webviews and camera requests remain blocked.
- TypeScript/JavaScript language diagnostics and formatting inherited from Code-OSS. Pinned ESLint, Prettier, Microsoft Python, BasedPyright, and native Ruff editor extensions are installed by bootstrap; project lint rules require that project’s ESLint configuration. Python supports hover information, ⌘click/F12 definitions, cross-file references, basic type diagnostics, Ruff linting, and formatting on save. Use **Python: Select Interpreter** for the project environment; installed dependencies determine third-party import navigation. Project Ruff configuration takes precedence over editor defaults. Additional language tooling can be installed through Open VSX.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the two-person PR workflow, [AGENTS.md](AGENTS.md) for agent instructions, and [agent development](docs/agent-development.md) for skills and specialist roles. MIT licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).
