# A quieter Zen workbench

Design study and interactive example, 8 October 2026. The first appearance slice now runs in the native editor; task workflows below are still a browser prototype.

## Current scope

Focus on one human and the voice assistant, personal memory and editor UI. The issue/PR lifecycle, specialist controls and colleague collaboration below are retained design explorations, deferred from the active roadmap. The prototype is not a feature checklist. Individual session continuity should work without tickets, boards or a shared room. [README](../README.md#roadmap) is the current priority source.

## Native slice implemented

Zen Light and Zen Dark ship as native TextMate/semantic themes with restrained function, import, type, string and number colors. Native editor and terminal spacing, tabs and separators use the same palette. The live pairing webview has a folding workboard, collapsed settings, visible research/errors and voice controls anchored below its scrollable content. The theme button updates the editor theme; folding retains the webview and its transport. Existing inline edit acceptance and language tooling are unchanged.

Use `Zen: Switch Light / Dark`, `Zen: Toggle Workboard` (⌘⌥J) and `Zen: Apply Calm Layout` from the command palette. Launch seeds missing appearance settings and migrates the previous Pair Graphite default, preserving custom choices. The explicit layout command applies the new defaults to an existing profile. Both packaged-runtime installation and source-overlay installation carry the extension manifest, themes and webview; no new upstream patch is needed for this slice.

Validation: type/lint/build, 65 unit/regression checks including runtime integrity, simulated panel lifecycle and browser interaction checks passed. Native light/dark appearance and fold/restore were inspected in an isolated empty window without changing workspace trust or starting a microphone/provider call. Live voice continuity still needs a human session. Task checkpoints, specialists, delivery integrations, Hindsight and shared editing are not connected to the native workboard yet.

## Try the example

```sh
npm ci
npm run prototype:zen
```

Open <http://127.0.0.1:4317>. No keys, microphone permission or editor bootstrap needed. `ZEN_PROTOTYPE_PORT` changes the port. The server binds to localhost and serves only the four prototype assets.

Try folding the workboard, switching appearance, focus mode, typing in the editor, accepting/discarding a proposal, and changing assistance to zero. Choose a task from its ID or project name. Pause a pairing session, switch tasks and return; reload to check persistence. Delivery walks through a synthetic review, explicit merge handoff, deployment and integration checks. Specialists opens Reviewer, Delivery and SRE fixture controls and editable rules. The pairing room demonstrates optional following and a guest view: both people can edit, while the inviter keeps assistant ownership.

**Real in this example:** layout, editable sample buffers, per-task browser persistence, local session checkpoints, specialist definition editing, proposal acceptance/stale-source protection, assistance controls, light/dark appearance, and keyboard commands.

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

The workboard has two modes:

- **Task:** intent, the current small step, decisions, resume context and useful research. Relevant documentation opens here on demand.
- **Delivery:** the next actionable review or verification result, with evidence links. The full lifecycle is available when requested, not constantly competing with code.
  Memory runs privately in the background, with controls in Settings rather than a workboard tab. A compact Specialists entry opens on-demand review and Delivery/SRE controls without adding a dashboard. See [local memory and shared tasks](local-memory-and-shared-tasks.md) for the current ownership and implementation contract.

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

Hindsight is the candidate for automatic memory local to the computer owner. This is separate from shared task state and from the existing Turso code index. [Local memory and shared tasks](local-memory-and-shared-tasks.md) covers the researched daemon, retain/recall/reflect pipeline, private scopes and inference destinations. The prototype does not start Hindsight.

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

Both people run Zen and edit the shared project concurrently, with independent cursors and optional following. The inviter owns the single assistant: start/stop, settings, tools and specialist agents. Collaboration does not transfer this ownership. Guest file edits invalidate stale AI proposals and review evidence exactly as host edits do.

The proposed implementation combines synchronized text buffers with a host-authoritative filesystem journal. Private memory and credentials are never part of the shared workspace. Host disconnection pauses the assistant rather than launching a second one on the guest. See the [detailed two-client contract and acceptance checks](local-memory-and-shared-tasks.md#shared-code-and-filesystem).

## Earlier full-product rollout (deferred beyond the core UI)

1. **Appearance and layout:** translate the palette into the built-in theme and set calm defaults in the maintained runtime/source patch scripts. Hide redundant chrome by default; retain escape hatches. Verify dark/light contrast, keyboard access, zoom and terminal rendering in a disposable native window.
2. **Native task shell:** replace the generic top chrome with compact project/task identity and add a persistent voice strip. Reuse Code-OSS layout services, Monaco, xterm, language tooling and native proposal renderer. Implement the workboard in the existing extension/webview, with typed host messages; no provider keys in the webview. Keep runtime/source overlays coherent.
3. **Durable local task state:** task switcher, checkout linkage, checkpoint storage, restore/reconciliation and history. First acceptance: resume a real task after restarting the editor, with correct unsaved-buffer handling and no microphone auto-start.
4. **One connected lifecycle:** one Linear issue and GitHub PR, event-backed read-only status, then authorized operations. First acceptance: new commits invalidate stale results; a failed integration check keeps the task incomplete.
5. **Collaboration:** shared task room, then shared buffers and the host-owned assistant. Validate two real clients, lost connections, independent navigation, speaker identity and conflicting edits before calling it pair programming.

The browser study is a design/interaction reference. It is not a replacement editor framework, a native UI patch, a real session-resumption implementation, or proof of a working cloud delivery pipeline.

## Native core UI pass

The shipped companion uses a compact workspace/file header, always-accessible assistance slider, conditional research cards and pairing controls beside the working agreement. Index details are expandable; progress and failures remain visible. Settings remain secondary. The status bar exposes acknowledged mute/unmute and end-session controls while voice is connected, including when the workboard is folded. Commands target the current session token; they reuse the panel's mute acknowledgement and disconnect lifecycle.

`scripts/native-shell.css` is the canonical native overlay, installed into both pinned source and the downloaded runtime. The launcher reapplies it idempotently and regenerates runtime checksums before signing. Styling keeps Monaco/xterm, native actions, resizing, keyboard focus and security indicators intact. New appearance defaults preserve existing user choices; Apply Calm Layout opts an existing profile into compact tabs and quiet tree/terminal defaults. This is the individual pairing surface; prototype task boards, team controls and delivery agents remain deferred.

## Reference layout correction

The initial native pass was primarily cosmetic and did not reproduce the design study. The structural overlay now reserves a 96px file heading and 28px horizontal editor insets (48px/12px in small splits), passes the reduced geometry to Monaco, and uses the same monospace font fallback as the study. Native tabs use a bottom underline. The title bar is 54px high to accommodate macOS window controls. One-time profile migration sets file tree/workboard/terminal proportions; later resizing persists. File headings show actual file names and paths, never a simulated task. The companion groups file context, actual checkpoint context, working agreement and voice controls without adding deferred issue/delivery features.

The reference is still a target, not evidence of a shipped pixel-perfect match. Native file handling, diagnostics, terminal controls and macOS window affordances remain functional. Runtime and source patches share the typed layout helper, fail on unexpected upstream anchors and retain integrity checks. Verify light/dark native windows after restart, small splits, file switching, inline acceptance and scrolling before claiming parity.

The macOS title-bar override also reserves the 54px height; the browser implementation alone does not control macOS. Pairing controls now follow current-file/research context in the main workboard flow, above the working agreement. Index progress and bounded, scrollable error details live in a bottom status strip. The duplicated workboard heading is removed. Automated 325px companion screenshots are generated in `artifacts/native-companion/`; these verify the webview, not full native-shell parity.

## Previous native pairing strip (superseded)

The editor now reserves a 44px bottom row for start, acknowledged mute/unmute, end, assistance presets, terminal and workboard controls. The row belongs to the bottom terminal panel when visible, otherwise to the editor. Monaco and xterm receive the remaining dimensions; no content is covered. Presets update the same assistance setting as the fine-grained slider and do not disconnect voice. Starting opens the workboard and waits for its ready handshake.

Explorer hides Outline and Timeline once per profile using native view visibility. Auxiliary panel tabs are unpinned once; diagnostics, output, debug and ports remain available from native menus and commands. Custom panels and later choices survive. File headings refresh immediately on tab changes. The launcher invalidates only rebuildable built-in extension scan caches so updated contributions appear on the first restart.

Validation includes 78 unit tests, simulated panel lifecycle, browser tests of the native layout helper and the prototype suite. Native light/dark surfaces, assistance synchronization and terminal folding were inspected in an isolated empty window; Explorer cleanup and file geometry were checked in the restricted demo. No folder trust or Keychain permissions were changed. This pass did not make live microphone/provider calls or exercise a native inline proposal.

## Simplified individual workboard

The October 8 cleanup supersedes the bottom pairing strip and generated file heading above. Pairing controls now have a single location in a compact toolbar at the top of the workboard. The normal panel shows only assistance and conditional research/activity/errors. The gear reveals configuration, keys, context controls and diagnostics; the light/dark control remains beside it. The native title bar has branding at left and a Workboard toggle at right, with no filename duplication. The OS window title is retained for window switching and accessibility.

On macOS the maintained main-process overlay calls Electron's `setWindowButtonVisibility(false)`. Native menus and shortcuts retain close/minimize/zoom/fullscreen, and title-bar dragging is preserved. Explorer's native delegate uses 28px rows so visual spacing agrees with hit testing and virtualization. Labels use 12px regular text; icons and twisties are quieter, and secondary header actions appear on hover or keyboard focus.

Runtime and source overlays are both updated. Validation covers 78 unit checks, simulated voice/panel lifecycle, native-title command/layout fixtures and the browser study. Native light/dark panels, settings toggle, title-bar folding and hidden macOS buttons were inspected in a disposable empty window. Microphone/provider calls and live native inline proposals were not exercised by this UI pass.
