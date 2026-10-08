# Personal memory and deferred collaboration ideas

Design update, 8 October 2026. This is the proposed production architecture. The browser workbench demonstrates the controls only: no Hindsight process, model calls, remote editing, cloud watcher or deployment operation is started.

## Current scope supersedes the earlier rollout

The active product is individual voice pair programming, personal memory and UI refinement. Hindsight remains the candidate implementation, not a running integration. Specialist agents, collaboration and delivery sections below preserve earlier research only; they are deferred and must not dictate the first memory implementation.

Memory should contain four distinct kinds of useful context:

| Kind                         | Examples                                                                                     | How to use it                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Personal preferences         | Coding style, favored approaches, pace and explanation detail                                | Prefer explicit statements and corrections; apply as defaults, subordinate to current instructions.                              |
| Repository/service knowledge | Structure, ownership of responsibilities, entrypoints, dependencies, architectural decisions | Scope to the repository/service, cite supporting files and recheck after relevant code/branch changes.                           |
| Learning context             | Topics the user says they know, explanations that helped, concepts they want to practice     | Keep topic-specific, editable and tentative when inferred; do not infer a fixed ability from questions, silence or typing speed. |
| Session continuity           | Decisions, accepted versus verified edits, unresolved questions, next step                   | Resume individual work without a ticket/project board or automatic microphone start.                                             |

Record whether a memory was explicitly stated, inferred or verified from code, plus its source, scope and time. A single accepted suggestion is not a global coding preference. Prefer a repo-specific convention within that repo; resolve conflicting or uncertain recollections using current evidence or a short clarification when needed. Retain useful summaries rather than every utterance. Recall only what helps the current interaction, and avoid repeatedly announcing remembered facts.

## Earlier product decisions (collaboration and specialists deferred)

- Light and dark appearances remain local preferences. Memory has no workboard tab.
- Memory is automatic background behavior for the computer's current OS user, scoped to their repositories, services and tasks. It is not a shared team memory store.
- A task has one host: the person who invited the others. Both host and collaborators can edit shared source files. They do not take turns holding an exclusive editing lock.
- One assistant coordinator and voice session belong to the host. Inviting a collaborator never starts a second assistant or transfers control. The host controls start/stop, models, assistance, tool permissions and specialist definitions.
- Reviewer, Delivery and SRE are subordinate workers with independent contexts and explicit tool profiles. Their findings return through the same workboard and assistant; they do not become competing speakers.

## What Hindsight actually does

Hindsight's **retain** operation extracts structured facts, entities and relationships from supplied content. Zen still has to choose which events to supply; installing Hindsight does not automatically make our editor interactions meaningful memories. [Retain architecture](https://hindsight.vectorize.io/developer/retain).

**Recall** combines semantic, keyword, graph and temporal retrieval. **Reflect** reasons over memories to answer a broader question. After retention, background consolidation forms observations and tracks supporting evidence. Use recall for ordinary context lookup, and reserve reflection for useful checkpoints or deliberate reasoning rather than each voice turn. [Recall architecture](https://hindsight.vectorize.io/developer/retrieval), [operations overview](https://github.com/vectorize-io/hindsight#the-three-operations), [observations](https://hindsight.vectorize.io/developer/observations).

A Node package, `@vectorize-io/hindsight-all`, supervises a separate local daemon; `@vectorize-io/hindsight-client` accesses it. The documented wrapper uses Node 22+, `uv`/`uvx`, a local profile and HTTP on loopback. It is a process supervisor, not an embedded TypeScript database. Pin its daemon/package versions rather than accepting the documented `latest` default. The wrapper documents profile persistence of supplied environment values, so production key handling needs inspection before passing secrets through it. [Node supervisor](https://hindsight.vectorize.io/sdks/hindsight-all-npm).

The default local database is pg0, an embedded PostgreSQL. Upstream describes this as convenient for development and recommends external PostgreSQL for production. A local prototype is viable; a shipped desktop app still needs crash/recovery, upgrade, backup, disk and dependency-packaging validation. Hindsight does not use our Turso database. [Installation and storage requirements](https://hindsight.vectorize.io/developer/installation).

Local storage and local inference are distinct. Hindsight uses an LLM for extraction/reasoning plus embedding and reranking models; it documents both hosted and local model providers. For a fully local setup, all three must be local. For local storage with hosted reasoning, the selected provider receives the content needed for processing. Make that destination explicit during setup, without adding a permanent workboard panel. Existing Turso code embeddings stay in their own model/dimension space; never copy Hindsight vectors into that index. [Model configuration](https://hindsight.vectorize.io/developer/models).

## Proposed automatic memory pipeline

The extension host emits meaningful events: a user correction, an accepted decision with rationale, an applied edit and its verification result, a review finding resolved, or a task checkpoint. Debounce and summarize these into small records; do not retain every keystroke, raw audio, credentials, raw cloud logs or an entire private repository. Distinguish the computer owner's preferences from a collaborator's statements. An accepted proposal is not automatically a verified fix.

A durable local outbox feeds Hindsight asynchronously. Use stable document IDs for each logical checkpoint and idempotent operation IDs for retries; keep revision order so an older retry cannot overwrite a newer checkpoint. Hindsight documents document upsert/replacement and caller-supplied operation IDs for async retention. Track async completion instead of calling queued work saved. [Retain API](https://hindsight.vectorize.io/developer/api/retain).

Suggested scope: a personal preference bank plus a separate bank per repository within the OS-user profile; service/task tags narrow retrieval further. Keep source commit/file, event ID, author, scope, verification state and timestamp alongside each record. Revalidate code assertions against current files. Corrections supersede old claims; forgetting must delete relevant evidence and prevent the outbox from immediately ingesting it again. Test what happens to derived observations during deletion rather than assuming propagation.

Read a small relevant memory set when opening a task or answering a question. Combine it with current buffers and scoped Turso retrieval, without making voice wait for consolidation. A unavailable or slow memory service must degrade to current project context. A bounded queue and workload scheduling protect interactive latency; they must not silently drop events or turn incomplete retrieval into full coverage.

Memory controls belong in private Settings/commands: enabled/paused, local inference destination, inspect/correct/forget, storage usage and health. Routine operation is silent. Failures should be discoverable; they should not repeatedly interrupt speech.

Use one supervisor per OS user across editor windows, stored under user application data and outside repositories. Loopback binding alone does not authenticate callers: add per-user access controls and a host-only credential boundary, and verify the chosen Hindsight authentication mechanism during implementation. No room client receives the Hindsight endpoint, bank IDs, provider credentials or raw recall results.

**Private memory is not shared room context.** With a collaborator present, use the agreed task checkpoint, current shared code and project conventions for the room assistant. Do not inject unrelated personal memories into a prompt whose output is broadcast to others. Promote a remembered project fact into shared context only after checking it against shared evidence or through an explicit host action. Each person's private memory remains local; no cross-device memory sync is implied. Shared session artifacts are a separate store with their own access rules.

## Specialist contracts

| Worker   | Trigger and input                                                                       | Tools                                                                                                | Result and authority                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer | Host command; immutable diff/base/head, relevant current buffers, conventions and rules | Scoped reads/search, definitions/references, approved check commands                                 | Actionable findings with severity, file/line, evidence and uncertainty. Read-only by default. No merge/deploy rights.                                            |
| Delivery | Host starts a PR/revision/environment workflow                                          | PR/check/review reads, approved merge operation, CI/deployment status, authorized integration runner | Track merge commit → build artifact → deployment revision → matching test results. Merge requires permission for that exact revision and repository protections. |
| SRE      | Host enables an environment watch with a duration/scope                                 | Read-only cloud logs, Sentry, metrics and deployment markers                                         | Deduplicated actionable incidents, evidence links and suggested investigation. No automatic restart, rollback or code change.                                    |

Definitions should include instructions, convention file references, model/effort policy, allowed tools, inputs, output schema, timeout/checkpoint behavior and scope. Repo-shared conventions are useful, but the host must adopt definitions before granting local tools. Prompt instructions cannot expand permissions. Treat comments, logs and repository text as untrusted data.

Illustrative definition, not a currently executable Zen config:

```json
{
  "id": "reviewer",
  "trigger": "host-command",
  "instructions": "Find concrete regressions and explain the trigger and consequence.",
  "conventions": ["AGENTS.md", "CONTRIBUTING.md"],
  "context": ["baseSha", "headSha", "bufferVersions", "diff"],
  "tools": [
    "read_file",
    "search_code",
    "find_references",
    "run_approved_check"
  ],
  "output": "findings-with-evidence",
  "mutations": "none"
}
```

The runtime enforces capabilities independent of the model. Each invocation gets a task ID, owner, run ID, source revision and cancellation/checkpoint state. Edits by either human or the assistant invalidate affected review/test evidence. No dependency on the GitHub Codex integration: the review agent runs in Zen and can optionally post results through an explicitly enabled GitHub adapter.

Long-running does not mean a continuous model loop. SRE uses a checkpointed event/poll scheduler with provider cursors, backoff, duplicate grouping and periodic reconciliation. Invoke reasoning on new evidence or investigation; stay quiet on unchanged status. Track gaps during disconnection and do not promise retrospective coverage the provider cannot supply. Delivery is a resumable state machine, including failure and unknown states.

Stopping voice does not silently cancel a deployment watch; each worker has its own stop control. Closing the editor can leave an explicitly enabled local supervisor running, but a sleeping/offline computer cannot monitor. Show that limitation, resume with reconciliation, and require a separate decision to move a worker to always-on infrastructure. Nothing here installs or schedules such a worker yet.

## Shared code and filesystem

Both participants run Zen. Start with a host-authoritative task worktree exposed as a scoped virtual workspace to collaborators. Share selected project source files, not the host's whole disk, `.env`, credentials, private memory or arbitrary system paths. Guests need file create/rename/delete as well as text editing; those operations need explicit protocols rather than syncing the whole directory blindly.

Use CRDT text synchronization for open buffers and a versioned host-side file-operation journal for filesystem changes. Yjs is a candidate for text concurrency, not a complete shared-filesystem or authorization layer. [Yjs overview](https://docs.yjs.dev/).

Use stable file IDs across renames. Serialize create/rename/delete with expected versions; distinguish host disk watcher events from writes already acknowledged. Handle unsaved buffers and external tools through the same reconciliation path. A deleted file with pending edits must yield an explicit recoverable conflict, not silent resurrection. Host acknowledgments establish persistence; a disconnected guest must not see its unsent text marked as saved. Preserve each person's undo history without undoing another person's unrelated changes.

| Capability                                                | Host                         | Collaborator                                 |
| --------------------------------------------------------- | ---------------------------- | -------------------------------------------- |
| Edit shared buffers and permitted project files           | Yes                          | Yes, concurrently                            |
| Own cursor, tabs, selection and theme                     | Yes                          | Yes                                          |
| Speak to / hear the room assistant                        | Yes                          | Yes, with individual microphone controls     |
| Start/stop the assistant or change model/assistance/tools | Yes                          | No; may ask the host                         |
| Run/configure specialist agents                           | Yes                          | Request through the host                     |
| Accept AI proposals                                       | Yes initially                | No initially; manual editing remains allowed |
| Execute terminal commands, merge or deploy                | Host-controlled capabilities | No implicit grant from edit access           |
| Access private memory or provider keys                    | Host's local account only    | No                                           |
| Invite/remove members                                     | Yes                          | No                                           |

Keep editing ownership and assistant ownership separate. No driver-handoff button is needed to let the second person type. Opt-in follow changes the viewport only; a person's input releases following. Zed's shared-project model is a useful interaction reference, but this host-owned assistant contract is Zen's design choice. [Zed collaboration](https://zed.dev/docs/collaboration/overview).

The single assistant coordinator runs on the host, receives both identified voice tracks and the current shared document versions, and emits one response stream to both people. Use stable speaker IDs; do not guess who spoke from text. Prevent assistant playback from re-entering input. A spoken request records its speaker and captured document/selection; guest speech does not acquire host tool authority. The two humans can talk freely; directing questions to the assistant needs an agreed activation/turn-taking rule to avoid answering every human-to-human remark.

A task-level lease/fencing token prevents two host windows from running the same assistant or executing duplicated tools. Subagents inherit that host authority with narrower scopes. If the host leaves or its lease expires, pause the assistant and shared writes, retain local pending drafts and show reconnect state. Do not automatically start the guest's assistant. Future explicit ownership transfer would stop the old owner, reconcile state and grant a new lease; it is outside the first collaboration version.

## Current implementation order and proof

1. Improve the existing voice/coaching loop and native UI using real individual pairing sessions; establish latency and interruption baselines.
2. Build the local personal-memory adapter and asynchronous retention/recall pipeline. Start with explicit preferences/corrections and source-backed repo/service findings. Prove correction/forget, isolation, freshness checks, crash recovery and responsiveness during retention. Audit actual processing destinations before claiming fully local inference.
3. Add individual session checkpoints and progressive, tentative learning context. Prove useful recall after restart with current buffers and without a ticket or automatic microphone start.
4. Refine recall quality and UI from observed use before expanding scope.

The browser preview retains Task/Delivery tabs, specialist examples and a simulated pairing room as earlier design exploration. These are not current implementation milestones. Collaboration, specialist execution and delivery/SRE adapters require a later explicit reprioritization.
