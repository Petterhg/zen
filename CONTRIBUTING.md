# Contributing to Zen

## Setup

The editor runtime currently supports macOS on Apple Silicon only. Use Node 22 (`nvm use`), npm, Git, and Xcode command-line tools (`xcode-select --install`). Bootstrap needs network access to GitHub and Open VSX. It downloads the pinned runtime and language tools; do not commit these downloads.

```sh
git clone https://github.com/Petterhg/zen.git
cd zen
nvm use
npm ci
npm run bootstrap
npm start
```

Each developer supplies their own API keys through Add API Keys, or copies `.env.example` to `.env`. Never share keys through Git. OpenAI and one supported reasoning provider are needed for live pairing; Firecrawl is optional. Provider/model availability depends on your account. Unit and simulated panel checks need no keys.

## Work together

For the current small-team workflow, commit validated changes and push directly to `main`. PRs are optional: create one when the user asks for review through GitHub. Fetch current main before pushing, integrate concurrent changes, and never force-push main.

Use a separate branch/worktree for concurrently running coding agents; do not have two agents write the same checkout. Agree on the behavior and affected area in the task. A short paragraph and observable acceptance criteria are enough; no mandatory specification or test-first ceremony. Report the resulting behavior, checks actually run, and remaining limitations with each handoff. Release publication and deployment still need human authorization.

## Local checks

```sh
npm ci
npx playwright install chromium
npm run validate
```

Install `rg` (ripgrep) on your PATH for repository-discovery tests when no editor runtime is present (`brew install ripgrep` on macOS). Build runs before tests because parser assets and browser protocol output are generated. `test:panel` uses Playwright Chromium; optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a local browser. CI runs these checks on Ubuntu without the full editor. Native macOS runtime integrity checks are skipped when that runtime is absent; CI does not prove microphone, signing, provider access, or macOS UI behavior.

For a runtime or voice change, also validate the affected flow in a disposable workspace on macOS. Save buffers before reloading. `test:ui` targets an explicitly launched debugging session and may call a paid backend; never point it at someone else's active editor. Keep fixtures synthetic and do not replay private traces into providers.

## Source map

- `extension/src/extension.ts`: host integration and native proposals.
- `extension/src/live-protocol.ts`, `extension/media/panel.js`: voice transport and playback state.
- `extension/src/backend.ts`, `exploration.ts`, `prompts.ts`: delegation and provider behavior.
- `extension/src/index-service.ts`, `code-index.ts`, `code-chunks.ts`: retrieval and indexing.
- `scripts/patch-runtime.mjs`, `patch-source.mjs`: pinned upstream overlays.
- `test/`: offline behavior and integration checks.

Generated outputs stay ignored. Change the source, then build. Preserve upstream notices and the existing MIT license. See AGENTS.md before using an agent.
