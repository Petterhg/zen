import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  commandTool,
  executeCommand,
  toolRevision,
  gatedTool,
} from "../extension/src/tool-registry.js";
import {
  Definitions,
  agentMarkdown,
  parseAgentMarkdown,
} from "../extension/src/definitions.js";
import { DEFAULT_AGENTS } from "../extension/src/subagents.js";
import { TaskWorkspace } from "../extension/src/task-workspace.js";
const exec = promisify(execFile);
const signal = () => new AbortController().signal;
function tool(code: string) {
  return commandTool({
    version: 1,
    name: "check_fixture",
    description: "Check fixture",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    runtime: {
      type: "command",
      command: [process.execPath, "-e", code],
      workingDirectory: "task-worktree",
      protocol: "json-stdio",
      timeoutMs: 1000,
    },
  });
}

test("JSON command contract validates arguments and outputs, strips provider credentials, and does not interpolate stdin", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "zen-tool-"));
  try {
    process.env.ZEN_TEST_SECRET = "never-inherit";
    const definition = tool(
      `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>console.log(JSON.stringify({ok:JSON.parse(input).value==='$(touch escaped)',leaked:process.env.ZEN_TEST_SECRET??null})));`,
    );
    const result = await executeCommand(
      definition,
      { value: "$(touch escaped)" },
      folder,
      signal(),
    );
    assert.deepEqual(result, { ok: true, leaked: null });
    await assert.rejects(readFile(path.join(folder, "escaped")), /ENOENT/);
    await assert.rejects(
      executeCommand(definition, { value: 42 }, folder, signal()),
      /schema/,
    );
    await assert.rejects(
      executeCommand(
        tool("console.log('not json')"),
        { value: "x" },
        folder,
        signal(),
      ),
      /JSON/,
    );
    await assert.rejects(
      executeCommand(
        tool("console.log('{}')"),
        { value: "x" },
        folder,
        signal(),
      ),
      /schema/,
    );
    await assert.rejects(
      executeCommand(tool("process.exit(2)"), { value: "x" }, folder, signal()),
      /code 2/,
    );
    await assert.rejects(
      executeCommand(
        tool("console.log('x'.repeat(260000))"),
        { value: "x" },
        folder,
        signal(),
      ),
      /256 KB/,
    );
    await assert.rejects(
      executeCommand(
        tool("setTimeout(()=>{},10000)"),
        { value: "x" },
        folder,
        signal(),
      ),
      /timed out/,
    );
    const controller = new AbortController();
    const pending = executeCommand(
      tool("setTimeout(()=>{},10000)"),
      { value: "x" },
      folder,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /cancelled/);
  } finally {
    delete process.env.ZEN_TEST_SECRET;
    await rm(folder, { recursive: true, force: true });
  }
});

test("definitions migrate once, preserve Markdown, reject stale saves and require regrant after edits", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "zen-defs-"));
  try {
    const defs = new Definitions(folder);
    await defs.initialize({ explorer: { instructions: "My conventions" } });
    assert.equal(defs.agents.explorer.instructions, "My conventions");
    const agent = {
      ...DEFAULT_AGENTS.explorer,
      orientation: false,
      instructions: "# Job\n\nImplement the requested task.\n",
      tools: ["read_file", "apply_patch"],
      workspace: "isolated-worktree" as const,
    };
    assert.equal(
      parseAgentMarkdown(agentMarkdown(agent)).instructions,
      agent.instructions.trimEnd(),
    );
    const revision = defs.revision;
    await defs.saveAgents({ implementer: agent }, revision);
    await assert.rejects(defs.saveAgents({}, revision), /changed/);
    const t = tool("console.log('{\"ok\":true}')");
    await defs.saveTool(t, defs.revision);
    assert.equal(defs.granted(t), false);
    await defs.savePolicy(
      { ...defs.policy, commandGrants: { [t.name]: toolRevision(t) } },
      defs.revision,
    );
    assert.equal(defs.granted(t), true);
    await defs.saveTool(
      { ...t, description: "Changed behavior" },
      defs.revision,
    );
    assert.equal(defs.granted(defs.tools[t.name]), false);
    await defs.saveTool(t, defs.revision);
    assert.equal(defs.granted(t), false);
    await defs.savePolicy(
      { ...defs.policy, commandGrants: { [t.name]: toolRevision(t) } },
      defs.revision,
    );
    await defs.deleteTool(t.name, defs.revision);
    await defs.saveTool(t, defs.revision);
    assert.equal(defs.granted(t), false);
    const policy = await readFile(path.join(folder, "library.json"), "utf8");
    assert.throws(
      () =>
        defs.savePolicy(
          { ...defs.policy, disabled: null as unknown as string[] },
          defs.revision,
        ),
      /Invalid/,
    );
    assert.equal(
      await readFile(path.join(folder, "library.json"), "utf8"),
      policy,
    );
    await defs.saveAgents({}, defs.revision);
    await defs.initialize(undefined);
    assert.deepEqual(defs.agents, {});
    await writeFile(path.join(folder, "tools", t.name + ".json"), "bad json");
    await assert.rejects(defs.reload());
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("tool gate denies revoked calls and results; schema rejects malformed values", async () => {
  let allowed = true,
    calls = 0;
  const t = gatedTool(
    {
      name: "fixture",
      description: "fixture",
      parameters: {
        type: "object",
        properties: { n: { type: "integer" } },
        required: ["n"],
        additionalProperties: false,
      },
      execute: async () => {
        calls++;
        allowed = false;
        return { ok: true };
      },
    },
    () => allowed,
  );
  await assert.rejects(t.execute({ n: "bad" }, signal()), /schema/);
  assert.equal(calls, 0);
  await assert.rejects(t.execute({ n: 1 }, signal()), /withheld/);
  assert.equal(calls, 1);
  await assert.rejects(t.execute({ n: 1 }, signal()), /revoked/);
  assert.equal(calls, 1);
  assert.equal(t.volatile, true);
});

test("implementer snapshots human edits, reads its writes, reviews only its changes, and cleans its checkout", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zen-task-")),
    root = path.join(home, "repo");
  await mkdir(root);
  const git = (args: string[]) => exec("git", args, { cwd: root });
  let task: TaskWorkspace | undefined;
  try {
    await git(["init", "-q"]);
    await git(["config", "user.email", "fixture@example.test"]);
    await git(["config", "user.name", "Fixture"]);
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(root, "b.ts"), "export const b = 1;\n");
    await writeFile(path.join(root, ".ignore"), "hidden/\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "fixture"]);
    await writeFile(path.join(root, "a.ts"), "export const a = 2;\n");
    task = new TaskWorkspace(
      root,
      path.join(home, "tasks"),
      [{ path: "b.ts", text: "export const b = 3;\n", version: 7 }],
      () => true,
    );
    await task.initialize(signal());
    const tools = task.tools();
    const patch = tools.find((t) => t.name === "apply_patch")!;
    await patch.execute(
      {
        path: "a.ts",
        operation: "replace",
        oldText: "a = 2",
        newText: "a = 4",
      },
      signal(),
    );
    await patch.execute(
      {
        path: "b.ts",
        operation: "replace",
        oldText: "b = 3",
        newText: "b = 5",
      },
      signal(),
    );
    await patch.execute(
      {
        path: "new.ts",
        operation: "create",
        oldText: "",
        newText: "export {};\n",
      },
      signal(),
    );
    const read = await tools
      .find((t) => t.name === "read_file")!
      .execute({ path: "a.ts" }, signal());
    assert.match(JSON.stringify(read), /a = 4/);
    const changes = await task.changes(signal());
    assert.equal(changes.files.length, 3);
    assert.equal(
      changes.files.find((f) => f.path === "a.ts")!.before,
      "export const a = 2;\n",
    );
    assert.equal(
      changes.files.find((f) => f.path === "b.ts")!.before,
      "export const b = 3;\n",
    );
    assert.equal(changes.files.find((f) => f.path === "b.ts")!.version, 7);
    assert.equal(
      await readFile(path.join(root, "a.ts"), "utf8"),
      "export const a = 2;\n",
    );
    assert.equal(
      await readFile(path.join(root, "b.ts"), "utf8"),
      "export const b = 1;\n",
    );
    for (const file of [".env", "../outside.ts", "hidden/new.ts"]) {
      await assert.rejects(
        patch.execute(
          { path: file, operation: "create", oldText: "", newText: "x" },
          signal(),
        ),
        /excluded|outside|ignore/,
      );
    }
    await symlink(path.join(root, "a.ts"), path.join(task.folder, "alias.ts"));
    await assert.rejects(
      patch.execute(
        { path: "alias.ts", operation: "replace", oldText: "a", newText: "b" },
        signal(),
      ),
      /Symlink/,
    );
    const folder = task.folder;
    await task.dispose();
    task = undefined;
    assert.doesNotMatch(
      (await git(["worktree", "list"])).stdout,
      new RegExp(folder),
    );
  } finally {
    await task?.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
