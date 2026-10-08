# Development with agents

AGENTS.md is the shared product contract. Skills contain focused workflows; agent profiles define narrow responsibilities. CI checks the implementation. Human review resolves product decisions and confirms the actual pairing experience. Prompts alone cannot guarantee alignment.

Canonical skills are under `.codex/skills/`, as requested for this project. Each `.agents/skills/<name>` symlinks to its canonical folder so Codex discovers it. Custom agent TOML files live in `.codex/agents/`. Open this repository as a trusted project in a current Codex client; project configuration must be reviewed before trusting it. We do not change approval policy or pin a particular model. Older clients can read the skill/profile instructions explicitly.

Available skills: `$zen-voice`, `$zen-editor`, `$zen-retrieval`, `$zen-review`.

Available agents: `zen_mapper` (read-only evidence), `zen_implementer` (assigned implementation), and `zen_reviewer` (read-only review). These development helpers are separate from the explorer inside the product. No automatic orchestration or background provider calls are installed.

Example task:

> Fix speech interruption when typing. Read AGENTS.md and use $zen-voice. Reproduce with the simulated panel, preserve spoken barge-in, and report offline versus live validation separately.

Example review:

> Have zen_reviewer review this branch against main using $zen-review. Return concrete regressions with file/line evidence; do not edit files.

For parallel work, give each writer a separate worktree and a bounded outcome with owned files, acceptance criteria and prohibited scope changes. One agent integrates the results and resolves overlaps. A reviewer should inspect the diff and relevant execution paths independently, rather than treating the implementer's summary as evidence. For a small change, one implementing agent and the other human reviewer are sufficient.

When a failure recurs, add a behavior regression test when practical and tighten the relevant skill only if it reveals a reusable decision rule. Keep one authoritative rule instead of duplicating long instructions. Changes to these rules should explain the product consequence. Follow the current direct-to-main workflow in CONTRIBUTING.md: validate, integrate concurrent changes and push without a PR unless requested. Repository protection settings are not changed automatically.

Configuration follows the official [custom agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [skill discovery documentation](https://learn.chatgpt.com/docs/build-skills). TOML/frontmatter validation does not prove a client loaded the roles; verify the skill selector and agent availability in your client.
