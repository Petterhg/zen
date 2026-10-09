# Tools and agents

Open **Zen: Settings** (or the workboard gear), then select **Agents** or **Tools** in the left menu. The **Agents** and **Tools** tabs share the same owner-local definitions. **Definition files** reveals the folder; **Import** and **Export** use native file pickers. No repository file is automatically executed or registered.

## Agent definition

Each file in `agents/` is named with its stable agent ID, for example `implementer.md`:

```markdown
---
name: Implementer
description: Use to implement a focused code change and verify it with tests.
enabled: true
orientation: false
model: deepseek-ai/DeepSeek-V4.1-Flash
reasoningEffort: medium
mode: foreground
workspace: isolated-worktree
tools:
  - read_file
  - read_files
  - find_files
  - search_text
  - git_diff
  - apply_patch
  - run_checks
---

Read the relevant source first. Keep changes focused on the delegated task.
Use apply_patch, then run_checks. Report what changed and what was actually
verified. Your changes are proposals awaiting human acceptance.
```

The description helps Main choose a worker. Instructions govern the task, while tool assignments are enforced by the host. Foreground waits; background lets the human and Main continue. Four workers can run concurrently. Names are roles chosen by the user, not hardcoded categories. Automatic orientation remains a bounded read-only synthesis using only assigned source tools; leave it off for implementers.

Shared workers use the open workspace's read tools. Isolated workers get checkout-aware `read_file`, `read_files`, `find_files`, `workspace_overview`, `search_text`, `git_diff` and `apply_patch` if assigned. Original-index and language-service tools are not exposed inside task checkouts because they would describe stale source. Web still requires an actual human request. Memory tools may be assigned; delegation and run control remain Main-only in this version.

## Command definition

Create a tool in **Tools**, or import a JSON file. For example `tools/run_checks.json`:

```json
{
  "version": 1,
  "name": "run_checks",
  "description": "Run repository tests and return a compact pass/fail result.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": { "passed": { "type": "boolean" } },
    "required": ["passed"]
  },
  "runtime": {
    "type": "command",
    "command": ["node", "tools/run-checks.mjs"],
    "workingDirectory": "task-worktree",
    "protocol": "json-stdio",
    "timeoutMs": 120000
  }
}
```

A corresponding repository script could be:

```js
import { spawnSync } from "node:child_process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
JSON.parse(input); // The host already validated the input schema.
const result = spawnSync(process.execPath, ["--test", "test/unit.test.mjs"], {
  encoding: "utf8",
});
console.log(
  JSON.stringify({
    passed: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(0, 12000),
  }),
);
```

Use fixed executable/arguments; model arguments arrive as JSON on stdin. Stdout must contain one complete JSON object. Send progress logs to stderr. Input and output schemas are JSON Schema draft-07 with object roots, no remote references or executable keywords. Output is bounded to 256 KB; keep results small enough for the agent (tool context is also bounded). Timeout is 1–600 seconds. Errors become tool feedback, not fabricated success.

Save, choose **Allow local execution…**, review the exact command, then assign it to an agent. Changing any part of the definition requires approval again. The **Available** checkbox globally disables a tool; **Main** assigns it to the main coding agent. In Agents, choose the tools each worker may use. Unknown or unavailable assignments do not acquire capabilities.

**A command grant is account-level local execution, not a sandbox.** A trusted command can read files or use the network as you, including outside its working directory. No provider keys or HOME are inherited, but code can find files independently. A worktree isolates intended edits; it does not prevent arbitrary commands from changing the real checkout. Only approve trusted executables and repository scripts. The grant covers the definition, not hashes of script files or their dependencies.

**Test saved tool** uses the same schema/permission/execution path in a disposable checkout. Currently it requires Main assignment, sharing enabled, assistance above zero and an open Git root. Test edits are discarded. Closing settings cancels the test. If dependencies are required, arrange them through a trusted command/environment; Zen does not copy node_modules, virtualenvs or secrets into the worktree.

## Review and lifecycle

Ask Main to delegate an implementation to your configured worker. It can read/write its isolated checkout and run assigned checks. When done, choose **Review changes** in the workboard or run inspector, open individual diffs, then choose **Accept all changes** or **Reject changes**. Main receives a compact report and change-set ID, not the worker's full transcript or patch bodies.

The starting snapshot includes permitted dirty files and unsaved buffers. Acceptance checks every original file against that snapshot and its captured version; a human edit or a previously accepted competing worker makes the affected proposal stale. Assistance zero prevents implementations; other slider values retain the line allowance. Native undo is preserved. Proposals are session-local and do not survive a restart. Stop/disconnect/privacy changes cancel workers; ordinary typing, navigation and slider changes do not interrupt speech.

Current limits: Git roots with a committed HEAD, UTF-8 text files up to 2 MB, at most 100 changed files / 4 MB per proposal, no file-mode-only proposals, no automatic merge of conflicting workers, no dependency installation, no MCP adapter yet. On macOS owned command process groups are killed on cancellation. A crash can leave a task worktree behind; no automatic removal of unknown worktrees occurs.

Validation distinguishes offline fixtures, live synthetic model calls, native editor checks and human voice sessions. The automated checks do not establish behavior for arbitrary user-provided commands or production environments.

## Validation of this implementation

Offline regression checks cover schema errors, process timeout/cancellation, environment filtering, stale settings saves, definition grants, dirty-buffer snapshots, ignored/new paths, tool revocation, guidance-only mode and stale multi-file acceptance. Browser tests exercise the actual settings assets with a simulated host. A live synthetic Cerebras → Together Flash task edited two files, ran its assigned check successfully and returned a proposal while the original checkout stayed unchanged. A disposable native editor check verified multi-file acceptance, unsaved buffers and grouped Undo. Human voice pairing with implementation workers remains to be tested together.

The workboard gear opens the same Settings editor at General. Select **Agents** or **Tools** in its left menu. Switching sections preserves unsaved definition edits; use the section’s Save controls to persist them. **Zen: Agent Settings** remains available as a command deep link.
