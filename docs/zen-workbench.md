# A quieter Zen workbench

Design study and interactive example, 8 October 2026. This proposes the next UI direction; it does not replace the running Code-OSS editor.

## Try the example

```sh
npm ci
npm run prototype:zen
```

Open <http://127.0.0.1:4317>. No keys, microphone permission or editor bootstrap needed. `ZEN_PROTOTYPE_PORT` changes the port. The server binds to localhost and serves only the four prototype assets.

Try folding the workboard, switching appearance, focus mode, typing in the editor, accepting/discarding a proposal, and changing assistance to zero. Choose a task from its ID or project name. Add a Memory note, pause a pairing session, switch tasks and return; reload to check persistence. Delivery walks through a synthetic review, explicit merge handoff, deployment and integration checks. The pairing room demonstrates optional following and driver handoff.

**Real in this example:** layout, editable sample buffers, per-task browser persistence, notes, local session checkpoints, proposal acceptance/stale-source protection, assistance controls, light/dark appearance, and keyboard commands.

**Simulated:** AI, voice, indexing status, terminal execution, Linear, GitHub, deployment/test results, remote presence and collaboration. Every task uses the same small gateway code fixture for layout testing. The textarea is a lightweight stand-in for the production editor, with no language service or full editor undo contract. The native app would keep Monaco, xterm, language extensions and its existing inline-edit renderer. Browser storage is local to this browser and origin; it is not a synchronized task store or durable backup. No external requests or raw audio recording occur.

Run `npm run test:prototype` for isolated Playwright checks. Screenshots are written to the ignored `artifacts/zen-workbench/` directory.

## What the research suggests

| Reference                                                                                                                                | Observed capability                                                                                          | Design inference for Zen                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [VS Code extension capabilities](https://code.visualstudio.com/api/extension-capabilities/overview)                                      | Themes, contributed views and webviews are supported; extensions cannot freely manipulate the workbench DOM. | Use supported theme/settings APIs first, then maintain a small source patch for the shell. A sidebar extension alone will not produce this layout.                    |
| [VS Code layout and Zen mode](https://code.visualstudio.com/docs/editing/getting-started/userinterface)                                  | Editor groups and surrounding parts can be shown/hidden; Zen mode reduces surrounding UI.                    | Reuse layout services, but keep task identity and voice controls accessible in Zen's own focus mode.                                                                  |
| [Terminal appearance](https://code.visualstudio.com/docs/terminal/appearance)                                                            | Terminal fonts, spacing and colors are configurable.                                                         | Style the existing terminal. Retain selection, accessibility, shell integration, links and real exit status.                                                          |
| [Linear GitHub integration](https://linear.app/docs/github-integration)                                                                  | Issues link to branches/PRs and can move through workflow states based on GitHub activity.                   | Start with stable issue/PR links and consume authoritative events. Avoid a second, conflicting issue-status system.                                                   |
| [Zed channels](https://zed.dev/docs/collaboration/channels)                                                                              | Persistent channels combine voice, shared projects and notes; participants can follow another collaborator.  | A task can have a persistent room, while editing and navigation remain independent by default.                                                                        |
| [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) | Environments support deployment protection rules and scoped configuration.                                   | Show the actual environment, revision and required approval; never equate a merged PR with a healthy release.                                                         |
| [Yjs](https://docs.yjs.dev/)                                                                                                             | Shared types and editor integrations support concurrent editing over multiple transport options.             | Evaluate Yjs for shared buffers, while separately designing identity, permissions, editor integration and terminal ownership. A CRDT does not solve those boundaries. |

These sources establish platform capabilities. The proposed UI and implementation sequence below are design judgments, not measured productivity claims or claims about competitors' internals.

## Visual and interaction direction

The code is the main surface. Use warm charcoal or soft stone backgrounds, muted sage for active state, restrained separators and readable system typography. Keep code and terminal monospace consistent. No remote font downloads; use the user's preferred installed font with fallbacks. Production font sizes must remain adjustable, and syntax/error contrast needs native accessibility validation.

Keep a narrow file tree, small tabs, one task title, a folding terminal and one folding workboard. The prototype has no activity bar, minimap, permanent search box, large chat composer, dashboard grid, duplicated AI controls or progress feed. Put infrequent navigation behind a command palette. Preserve search, Git, diagnostics, extensions and debugging as accessible commands/views. A minimal default must not remove the language tooling people rely on.

The workboard has three modes:

- **Task:** intent, the current small step, decisions, resume context and useful research. Relevant documentation opens here on demand.
- **Delivery:** the next actionable review or verification result, with evidence links. The full lifecycle is available when requested, not constantly competing with code.
- **Memory:** inspectable repository/service/task notes with provenance, freshness and a way to forget or correct them.

Voice is a participant, not a running transcript. Show connected/listening/muted/speaking states and one clear stop control. Keep transcript access in history/diagnostics. Do not announce every lookup or narrate unchanged progress. Typing, navigation, folding panels and changing assistance must not restart the speaker. At zero assistance, explain only. Optional code pointing must not steal the human's cursor.

Only actionable failures interrupt the calm: lost connection, rejected stale edits, failed checks or permission decisions. Color is never the sole indicator. Focus mode must be reversible without losing the task, voice controls, selection or draft.

## Persist the task, reconnect the voice

Use a stable task identity independent of a provider session ID. A possible host-owned contract:

```ts
interface TaskWorkspace {
  id: string;
  repositoryId: string;
  serviceIds: string[];
  issue?: { provider: "linear"; id: string; url: string };
  checkout: { worktreeId: string; branch: string; baseCommit: string };
  pullRequest?: { repository: string; number: number; headSha: string };
  checkpoint: {
    summary: string;
    nextStep: string;
    decisionIds: string[];
    fileAnchors: Array<{ path: string; version: string; line: number }>;
    openQuestions: string[];
  };
  updatedAt: string;
}
```

Persist approved decisions and compact checkpoints after meaningful work, including disconnection. On return, load the task, reconcile checkout/current buffers and provider state, then establish a fresh voice transport after explicit start. Restore context selectively; do not blindly replay the entire transcript or trust obsolete line numbers. Save user drafts through the editor's normal recovery mechanism, not just the task summary. A task switch must save the outgoing workspace and never retarget in-flight tools.

For a first production slice, host-local Turso can hold task metadata, checkpoints and evidence references. Keep credentials in SecretStorage. A future shared room needs an authenticated synchronization service; a local database by itself is not multi-user collaboration.

Memory can sit behind a provider interface, with Hindsight as a candidate rather than a prerequisite. Namespace knowledge by organization/repository/service/task, with separate personal preferences. Retain source, commit, author, timestamp and review state. Retrieve scoped memories alongside current code, invalidate stale assertions and surface disagreements. Do not automatically promote a task's speculation into a repository convention. Permissions must be enforced independently of hierarchy. See the separate memory roadmap proposal; this prototype only stores explicit local notes.

## The issue-to-verification loop

| Step             | What Zen shows                                                | Authority and guard                                                               |
| ---------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Select issue     | Intent, acceptance criteria, linked service, prior checkpoint | Linear issue plus explicit user selection; one active workspace                   |
| Work             | Code, current selection, relevant context, small inline edits | Current buffers, assistance level, captured target/version, undo                  |
| Open PR          | Diff, checks, linked issue, PR URL                            | Explicit publish action; GitHub PR head SHA                                       |
| Review and fix   | Unresolved bot/human findings near their code                 | Preserve review thread IDs and head SHA; revalidate anchors after edits           |
| Merge            | Review/check status and explicit merge action                 | GitHub protections and user authority; do not infer permission from a green badge |
| Monitor delivery | Build, deployment, environment and revision                   | GitHub Actions/deployment and cloud events; absence is unknown                    |
| Integration test | Actual test run, target environment and deployed artifact     | Authorized test runner; results must match the artifact under test                |
| Next issue       | Verified outcome, remaining risks, saved checkpoint           | User advances after agreed acceptance criteria; failures keep the task open       |

Production should process idempotent events and reconcile after reconnects. New commits invalidate earlier check/review evidence as appropriate. Match checks to PR head; match deployment and integration evidence to the resulting commit/artifact, including squash merge mappings. An old successful run must never green-light a new revision. Webhook text, bot comments and logs are untrusted data, not instructions for the assistant.

Begin with read-only Linear/GitHub links and status. Add writes deliberately: branch/PR creation, review replies, fixes, merge and deployment are separate operations with explicit ownership and authorization. AWS/GCP access stays host/server-side and starts with narrowly scoped status/log reads. Running integration tests can mutate services and must use an identified environment and authorized command. Do not create a UI that pretends all organizations deploy the same way.

## Pairing with a colleague

Build in increments:

1. **Shared task room:** identity, presence, approved notes/checkpoints and voice participants. Both people see the same task, but retain independent navigation. Joining a task is not automatically permission to access every repository, shell or secret.
2. **Shared editing:** evaluate Yjs or an existing collaboration integration with Code-OSS buffers. Test concurrent edits, reconnect, undo, file rename/delete, language-server ownership and conflicts with AI proposals. Keep proposals anchored to document versions and show who accepted each change.
3. **Shared assistant:** one task coordinator prevents duplicate tools and conflicting proposals. Give voice tracks speaker identity; route tool authority through the current driver. Design turn-taking and echo suppression explicitly. Following is opt-in and breaks when a person navigates or types. Driver changes must not silently grant repository/cloud permissions.

Use explicit terminal execution ownership and operation IDs for retries. Approval attribution and durable audit events matter more than synchronized cursors. Raw audio storage remains an explicit, separate choice for all participants. The prototype demonstrates only presence/follow controls; it does not establish a working collaborative backend.

## Bringing this into the actual editor

1. **Appearance and layout:** translate the palette into the built-in theme and set calm defaults in the maintained runtime/source patch scripts. Hide redundant chrome by default; retain escape hatches. Verify dark/light contrast, keyboard access, zoom and terminal rendering in a disposable native window.
2. **Native task shell:** replace the generic top chrome with compact project/task identity and add a persistent voice strip. Reuse Code-OSS layout services, Monaco, xterm, language tooling and native proposal renderer. Implement the workboard in the existing extension/webview, with typed host messages; no provider keys in the webview. Keep runtime/source overlays coherent.
3. **Durable local task state:** task switcher, checkout linkage, checkpoint storage, restore/reconciliation and history. First acceptance: resume a real task after restarting the editor, with correct unsaved-buffer handling and no microphone auto-start.
4. **One connected lifecycle:** one Linear issue and GitHub PR, event-backed read-only status, then authorized operations. First acceptance: new commits invalidate stale results; a failed integration check keeps the task incomplete.
5. **Collaboration:** shared task room, then shared buffers and coordinated AI. Validate two real clients, lost connections, independent navigation, speaker identity and conflicting edits before calling it pair programming.

The browser study is a design/interaction reference. It is not a replacement editor framework, a native UI patch, a real session-resumption implementation, or proof of a working cloud delivery pipeline.
