import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { build } from "esbuild";
import { Definitions } from "../extension/src/definitions.js";
import { DEFAULT_AGENTS } from "../extension/src/subagents.js";
import type { Automation } from "../extension/src/automation.js";
import type { ChangeSet } from "../extension/src/task-workspace.js";
const requireNative = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [path.resolve("extension/src/automation.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  write: false,
});

test("host assignments, revocation, guidance-only mode and stale multi-file acceptance", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "zen-automation-")),
    root = path.join(home, "repo");
  await mkdir(root);
  const git = (args: string[]) =>
    promisify(execFile)("git", args, { cwd: root });
  let level = 100,
    sharing = true,
    applied = 0;
  const uri = (fsPath: string) => ({
    fsPath,
    scheme: "file",
    toString: () => fsPath,
  });
  const buffers = new Map<
    string,
    {
      uri: ReturnType<typeof uri>;
      version: number;
      text: string;
      getText: () => string;
      positionAt: (n: number) => number;
    }
  >();
  const document = (file: string, text: string, version = 1) => {
    const d = {
      uri: uri(file),
      version,
      text,
      getText: () => d.text,
      positionAt: (n: number) => n,
    };
    buffers.set(file, d);
    return d;
  };
  class Edit {
    edits: unknown[] = [];
    createFile(...args: unknown[]) {
      this.edits.push(args);
    }
    insert(...args: unknown[]) {
      this.edits.push(args);
    }
    deleteFile(...args: unknown[]) {
      this.edits.push(args);
    }
    replace(...args: unknown[]) {
      this.edits.push(args);
    }
  }
  const mock = {
    Uri: { file: uri },
    WorkspaceEdit: Edit,
    Position: class {},
    Range: class {},
    workspace: {
      workspaceFolders: [{ name: "repo", uri: uri(root) }],
      get textDocuments() {
        return [...buffers.values()];
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      openTextDocument: async (u: ReturnType<typeof uri>) =>
        buffers.get(u.fsPath) ??
        document(u.fsPath, await readFile(u.fsPath, "utf8")),
      applyEdit: async (e: Edit) => {
        assert.ok(e.edits.length >= 2);
        applied++;
        return true;
      },
    },
  };
  const module = { exports: {} } as {
    exports: { Automation: typeof Automation };
  };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    (n: string) => (n === "vscode" ? mock : requireNative(n)),
    module,
    module.exports,
  );
  let automation: Automation | undefined;
  try {
    await git(["init", "-q"]);
    await git(["config", "user.email", "test@example.test"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(path.join(root, "a.ts"), "a=1\n");
    await writeFile(path.join(root, "b.ts"), "b=1\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "fixture"]);
    const defs = new Definitions(path.join(home, "definitions"));
    await defs.initialize(undefined);
    const profile = {
      ...DEFAULT_AGENTS.explorer,
      orientation: false,
      tools: ["read_file", "apply_patch"],
      workspace: "isolated-worktree" as const,
    };
    await defs.saveAgents({ implementer: profile }, defs.revision);
    automation = new module.exports.Automation(
      defs,
      path.join(home, "tasks"),
      () => sharing,
      () => level,
      () => {},
    );
    await defs.savePolicy(
      { ...defs.policy, mainTools: ["read_file", "apply_patch"] },
      defs.revision,
    );
    level = 0;
    const main = await automation.prepare(
      "main",
      undefined,
      [
        {
          name: "read_file",
          description: "fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ ok: true }),
        },
      ],
      new AbortController().signal,
    );
    assert.deepEqual(
      main.tools.map((t) => t.name),
      ["read_file"],
    );
    await main.dispose();
    level = 0;
    await assert.rejects(
      automation.prepare(
        "implementer",
        profile,
        [],
        new AbortController().signal,
      ),
      /guidance/,
    );
    level = 100;
    const env = await automation.prepare(
      "implementer",
      profile,
      [],
      new AbortController().signal,
    );
    try {
      assert.deepEqual(env.tools.map((t) => t.name).sort(), [
        "apply_patch",
        "read_file",
      ]);
      await env.tools
        .find((t) => t.name === "apply_patch")!
        .execute(
          {
            path: "a.ts",
            operation: "replace",
            oldText: "a=1",
            newText: "a=2",
          },
          new AbortController().signal,
        );
      const changes = await env.finish();
      assert.ok(changes);
      assert.equal(automation.summaries()[0].files[0], "a.ts");
      await defs.saveAgents(
        { implementer: { ...profile, tools: ["read_file"] } },
        defs.revision,
      );
      await assert.rejects(
        env.tools
          .find((t) => t.name === "apply_patch")!
          .execute(
            {
              path: "a.ts",
              operation: "replace",
              oldText: "a=2",
              newText: "a=3",
            },
            new AbortController().signal,
          ),
        /revoked/,
      );
    } finally {
      await env.dispose();
    }
    const a = document(path.join(root, "a.ts"), "a=1\n", 3),
      b = document(path.join(root, "b.ts"), "b=1\n", 2);
    const change: ChangeSet = {
      id: "review",
      root,
      status: "pending",
      files: [
        { path: "a.ts", before: a.text, after: "a=2\n", version: 3 },
        { path: "b.ts", before: b.text, after: "b=2\n", version: 2 },
      ],
    };
    b.text = "human change";
    b.version++;
    await assert.rejects(automation.accept(change), /changed since/);
    assert.equal(applied, 0);
    b.text = "b=1\n";
    b.version = 2;
    level = 0;
    await assert.rejects(automation.accept(change), /guidance/);
    level = 100;
    await automation.accept(change);
    assert.equal(applied, 1);
    assert.equal(change.status, "accepted");
    sharing = false;
    assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "a=1\n");
  } finally {
    automation?.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
