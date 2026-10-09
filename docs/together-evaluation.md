# Together AI model evaluation

This document records the initial synthetic evaluation and subsequent isolated research integration. Fast foreground pairing remains on Cerebras. The original benchmark models are `deepseek-ai/DeepSeek-V4.1-Flash` and `zai-org/GLM-5.3-Flash`. Together's [serverless catalog](https://docs.together.ai/docs/serverless/models) lists both with function calling and structured outputs; successful account access was verified in the synthetic checks below. API availability and documented limits can change.

## Keys and running

Use the application's `.env`, created locally from `.env.example`, with `TOGETHER_API_KEY=...`. It is ignored by Git. The standalone command reads only this key, from the process environment first, then that fixed application file; an explicit developer key-file argument is allowed. It does not read a repository opened in Zen or use editor SecretStorage. Use owner-only file permissions (`chmod 600 .env`) and never paste keys into chat, source, settings or reports.

```sh
npm run eval:together
# For an isolated development worktree using your main clone's key file:
npm run eval:together -- /absolute/path/to/zen/.env
```

Existing OpenAI/Cerebras/Firecrawl keys may be in a previous prototype's `.env`; clone/move operations do not migrate ignored files. In the editor, encrypted SecretStorage overrides launch environment variables, which override the application's development `.env`. Keys entered in Add API Keys belong to the runtime profile and are not exported into `.env`. The developer evaluation command cannot extract them.

## What is measured

The dependency-free HTTP harness follows Together's [chat completions API](https://docs.together.ai/reference/chat-completions), [structured outputs](https://docs.together.ai/docs/inference/chat/structured-outputs), and [tool calling](https://docs.together.ai/docs/inference/function-calling/overview). Four built-in synthetic cases exercise:

- A concise current-file explanation.
- A cited service summary with explicit unknowns.
- A cancellation review containing a deliberate `continue` bug.
- One forced fixture read and a matching tool-result follow-up.

The tool case is a protocol compatibility check, not proof of autonomous exploration quality. Tool arguments must name the requested synthetic file; no disk reads, commands or writes are possible. JSON summaries require known paths and in-range lines, but valid citations do not prove correct interpretation. Inspect answers for actual dependency flow, missing failure handling and the cancellation bug's consequence.

Each model makes at most five calls in one run. The explicit evaluation cap is 4,096 output tokens per call with a 120-second network deadline; reasoning can consume that budget, so truncation is reported as failure, never a successful partial answer. There are no automatic retries or silent model substitutions. Authentication failure stops further requests. Reasoning settings stay at the provider default because model-specific support is not inferred from generic docs. This cap does not change the application's research budgets or context handling.

Ignored, owner-only `artifacts/together/*.json` reports contain complete-request duration, finish reason, token usage, final answer and checks. No prompts from private repositories, credentials, provider error bodies or reasoning text are stored. Thinking fields may be preserved in a tool wire roundtrip when a model returns them, but never appear in the report. Timings are neither first-token nor audible-voice latency, and one run cannot establish average performance, production reliability or a quality ranking.

## Initial routing proposal (superseded by the integration below)

If live results are useful, add an explicitly configurable research provider/model for the existing isolated explorer and service-card synthesis, leaving fast foreground pairing on its current backend. Feed compact verified findings back to that backend/speaker; do not let large raw research conversations fill the pairing context. Evaluate the same synthetic cases with existing backends before choosing a default. Dedicated review agents remain deferred; the review fixture evaluates reasoning capability only. Together selection, automatic escalation, full native-tool integration and human voice validation are not implemented by this harness.

## October 9, 2026: first live check

Both exact requested models completed all four cases with the authorized account. The structured summaries/reviews had valid fixture citations, and both performed the requested synthetic read plus matching tool-result continuation. Both identified the cancellation branch's `continue` bug. Provider-default reasoning was present in separate fields and was excluded from reports.

| Case                    | DeepSeek V4.1 Flash | GLM-5.3 Flash |
| ----------------------- | ------------------: | ------------: |
| File explanation        |               2.1 s |         2.0 s |
| Service summary         |               7.1 s |         8.8 s |
| Cancellation review     |               5.3 s |        20.5 s |
| Two-call tool roundtrip |               2.6 s |         5.2 s |

These are single complete-answer samples on very small synthetic inputs, not throughput/large-context benchmarks or a model ranking. GLM's summary described the flow as strictly synchronous and the gateway as external without sufficient evidence, while also listing those internals as unknown. Its citations passed structural validation; interpretation still needed review. DeepSeek was faster on the deeper cases in this run, making it a reasonable first candidate for a configurable isolated research path, not evidence that it is universally better. At this initial checkpoint neither was integrated into Zen; the implementation below now routes isolated research through Together. Required local validation passed 122 tests plus type/lint/build and simulated panel/native-layout/prototype checks; no human microphone or private-repository Together run was performed. Generated results and keys remain ignored locally.

## Current editor integration

Together now runs the isolated Explorer and Deep research profiles. Explorer defaults to DeepSeek V4.1 Flash; Deep research defaults to `deepseek-ai/DeepSeek-V4-Pro-0813`. GLM-5.3 Flash remains an alternative in **Zen: Agent Settings**. Profiles have enabled state, instructions and soft reasoning depth controls; Off is an actual thinking toggle. Foreground conversation, inline proposals and memory remain on Cerebras. See the [current behavior and delegation contract](live-behavior.md#configurable-together-research-profiles).

Together’s [serverless catalog](https://docs.together.ai/docs/serverless/models) lists all three models with function calling and structured outputs. The application uses a conservative one-million-token research context estimate, reserving output room, and retains scoped discovery rather than loading the repository. These are provider capacity estimates, not a claim that a model understands all supplied code.

Actual application checks used local keys and synthetic source only. Flash, Pro and GLM each accepted Off reasoning with a valid structured answer. Cerebras selected the named research profile, the Together child inspected the synthetic files through the application tool loop, and compact evidence returned to Cerebras. Flash finished in about 8 seconds; Pro samples took about 15–30 seconds. These include complete delegation and answers, not voice latency, and are too few to rank reliability. Some Pro/parent interpretations still inferred durable side effects from opaque calls and repeated discovery; source citations alone did not catch that. Prompt guidance was tightened, but semantic correctness and large-context performance remain evaluation work. The standalone `eval:together` command still benchmarks the original two models independently; Pro was checked through the real application backend/delegation path.

### User-defined workers

The current Agent settings page uses a generic registry. Explorer/Deep research are editable examples, not reserved roles or effort-based routes. The main agent sees enabled names/descriptions in `delegate_to_agents`, can batch foreground and background jobs, and can inspect their results by ID. See [the current lifecycle and validation contract](live-behavior.md#user-defined-subagents-and-observable-runs-2026-10-09). The synthetic evaluator above remains a separate provider comparison command.
