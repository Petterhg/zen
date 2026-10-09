import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import type { BackendTool } from "../extension/src/backend.js";
const requireNative = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [
    path.resolve(import.meta.dirname, "../extension/src/workspace-tools.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  write: false,
});
test("workspace tools retain unsaved reads, scoped search and language-service evidence without a global inventory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pair-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "services/ner/src"), { recursive: true });
  await mkdir(path.join(root, "services/other"), { recursive: true });
  await writeFile(
    path.join(root, "services/ner/src/main.py"),
    "DISK VERSION\n",
  );
  await writeFile(
    path.join(root, "services/ner/src/extractor.py"),
    "def extractor():\n    return 1\n",
  );
  await writeFile(path.join(root, "services/ner/.env"), "PRIVATE_KEY=secret");
  await writeFile(
    path.join(root, "services/other/main.py"),
    "outside target scope needle\n",
  );
  let enabled = true;
  const uri = (fsPath: string) => ({ fsPath, scheme: "file" });
  const mock = {
    env: {
      appRoot: path.resolve(
        import.meta.dirname,
        "../.runtime/VSCodium.app/Contents/Resources/app",
      ),
    },
    Uri: { file: uri },
    Position: class {
      constructor(
        readonly line: number,
        readonly character: number,
      ) {}
    },
    workspace: {
      isTrusted: true,
      textDocuments: [
        {
          uri: uri(path.join(root, "services/ner/src/main.py")),
          isDirty: true,
          version: 12,
          getText: () => "# UNSAVED needle\nfrom .extractor import extractor\n",
        },
      ],
      workspaceFolders: [{ name: "repo", uri: uri(root) }],
      openTextDocument: async (u: { fsPath: string }) => {
        const dirty = u.fsPath === path.join(root, "services/ner/src/main.py");
        const text = dirty
          ? "# UNSAVED needle\nfrom .extractor import extractor\n"
          : await readFile(u.fsPath, "utf8");
        return {
          uri: u,
          version: dirty ? 12 : 1,
          isDirty: dirty,
          lineCount: text.split("\n").length,
          lineAt: (i: number) => ({ text: text.split("\n")[i] }),
          getText: () => text,
          validatePosition: (p: unknown) => p,
        };
      },
    },
    commands: {
      executeCommand: async () =>
        ["services/ner/src/extractor.py", "services/ner/.env"].map((p) => ({
          uri: uri(path.join(root, p)),
          range: { start: { line: 0, character: 4 } },
        })),
    },
    languages: { getDiagnostics: () => [] },
  };
  const module: {
    exports: { workspaceTools?: (enabled: () => boolean) => BackendTool[] };
  } = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    (name: string) => (name === "vscode" ? mock : requireNative(name)),
    module,
    module.exports,
  );
  const tools = module.exports.workspaceTools!(() => enabled);
  const run = async (name: string, args: Record<string, unknown>) =>
    (await tools
      .find((t) => t.name === name)!
      .execute(args, new AbortController().signal)) as Record<string, unknown>;
  const read = await run("read_file", { path: "services/ner/src/main.py" });
  assert.equal(read.unsaved, true);
  assert.equal(read.version, 12);
  assert.equal(
    read.hash,
    createHash("sha256")
      .update("# UNSAVED needle\nfrom .extractor import extractor\n")
      .digest("hex"),
  );
  assert.match(String(read.lines), /UNSAVED needle/);
  assert.doesNotMatch(String(read.lines), /DISK VERSION/);
  const search = await run("search_text", {
    query: "needle",
    scope: "services/ner/src",
  });
  assert.deepEqual(
    (search.matches as { path: string; version: number }[]).map((m) => ({
      path: m.path,
      version: m.version,
    })),
    [{ path: "services/ner/src/main.py", version: 12 }],
  );
  assert.equal(search.complete, true);
  const batch = await run("read_files", {
    files: [
      { path: "services/ner/src/main.py" },
      { path: "services/ner/src/extractor.py" },
      { path: "services/ner/.env" },
    ],
  });
  const batchFiles = batch.files as {
    path: string;
    lines?: string;
    version?: number;
    hash?: string;
    error?: string;
  }[];
  assert.equal(batchFiles[0].version, 12);
  assert.equal(batchFiles[0].hash, read.hash);
  assert.match(batchFiles[0].lines!, /UNSAVED needle/);
  assert.match(batchFiles[2].error!, /excluded/);
  assert.doesNotMatch(JSON.stringify(batch), /PRIVATE_KEY/);
  const map = await run("service_context", {
    path: "services/ner/src/main.py",
  });
  assert.equal(map.scope, "services/ner");
  assert.ok((map.seedFiles as string[]).includes("services/ner/src/main.py"));
  assert.doesNotMatch(
    JSON.stringify(map),
    /services\/other|PRIVATE_KEY|\.env|UNSAVED needle/,
  );
  const peer = await run("service_context", {
    path: "services/ner/src/main.py",
    scope: "services/other",
  });
  assert.equal(peer.currentFile, undefined);
  assert.doesNotMatch(JSON.stringify(peer), /services\/ner/);
  const usages = await run("symbol_usages", {
    path: "services/ner/src/main.py",
    line: 2,
    column: 7,
    kind: "definition",
  });
  assert.deepEqual(usages.locations, [
    { path: "services/ner/src/extractor.py", line: 1, column: 5 },
  ]);
  await assert.rejects(
    run("read_file", { path: "services/ner/.env" }),
    /excluded/,
  );
  const originalRoots = mock.workspace.workspaceFolders;
  mock.workspace.workspaceFolders = [];
  await assert.rejects(
    run("read_file", { path: "services/ner/src/main.py" }),
    /roots changed/,
  );
  mock.workspace.workspaceFolders = originalRoots;
  enabled = false;
  await assert.rejects(
    run("service_context", { scope: "services/ner" }),
    /disabled/,
  );
  await assert.rejects(
    run("read_file", { path: "services/ner/src/main.py" }),
    /disabled/,
  );
  enabled = true;
  mock.workspace.isTrusted = false;
  await assert.rejects(
    run("find_files", { query: "main.py", scope: "services/ner" }),
    /disabled/,
  );
});
