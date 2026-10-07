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

Use one short-lived branch per task (`cursor/describe-change` is the agent default), and a separate worktree for concurrently running coding agents. Do not have two agents write the same checkout. Agree on the behavior and affected area in the issue or PR; a short paragraph and observable acceptance criteria are enough. No mandatory specification or test-first ceremony.

Open a small PR against `main`. Include the problem, resulting behavior, checks actually run, and remaining limitations. Have the other developer review it, then squash merge after CI passes. Update your branch from main before resolving conflicting changes. Agents may prepare commits and PRs when requested; merging and release publication need human authorization. Branch protection is recommended but is not configured by this repository.

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
