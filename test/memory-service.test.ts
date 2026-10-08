import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { createRequire } from "node:module";
import type { PersonalMemory } from "../extension/src/memory-service.js";
const nativeRequire = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: ["extension/src/memory-service.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  write: false,
});
test("memory tools require human evidence, preserve captured repo, reject private/stale sources and honor pause", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zen-memory-integration-"));
  const storage = await mkdtemp(path.join(tmpdir(), "zen-memory-profile-"));
  await mkdir(path.join(root, "services"));
  const file = path.join(root, "services/auth.ts");
  await writeFile(file, "export function authorize() { return true; }");
  await writeFile(path.join(root, ".pairignore"), "private.ts\n");
  await writeFile(path.join(root, "private.ts"), "secret implementation");
  const config: Record<string, unknown> = {
    memoryEnabled: true,
    shareEditorContext: true,
  };
  const uri = (file: string) => ({
    scheme: "file",
    fsPath: file,
    toString: () => `file://${file}`,
  });
  const folder = { name: "repo", uri: uri(root) };
  const mock = {
    Uri: {
      file: uri,
      parse: (s: string) => uri(s.replace(/^file:\/\//, "")),
      joinPath: (base: { fsPath: string }, name: string) =>
        uri(path.join(base.fsPath, name)),
    },
    env: { appRoot: root },
    workspace: {
      isTrusted: true,
      workspaceFolders: [folder],
      getWorkspaceFolder: (u: { fsPath: string }) =>
        u.fsPath.startsWith(root + path.sep) ? folder : undefined,
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => config[key] ?? fallback,
      }),
      openTextDocument: async (u: { fsPath: string }) => ({
        getText: () => buffers.get(u.fsPath) ?? "",
      }),
    },
  };
  const buffers = new Map([
    [file, "export function authorize() { return true; }"],
  ]);
  const module = { exports: {} as { PersonalMemory: typeof PersonalMemory } };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    (id: string) => (id === "vscode" ? mock : nativeRequire(id)),
    module,
    module.exports,
  );
  const memory = new module.exports.PersonalMemory(
    {
      globalStorageUri: uri(storage),
      secrets: { get: async () => undefined },
    } as never,
    () => {},
  );
  try {
    const scope = await memory.scope(`file://${file}`);
    const signal = new AbortController().signal;
    const tools = memory.tools("I prefer small functions.", scope);
    const remember = tools.find((t) => t.name === "remember_pairing_context")!;
    const pref = {
      key: "code.function-size",
      scope: "personal",
      kind: "preference",
      text: "Prefer small functions.",
      evidence: "I prefer small functions.",
      sources: [],
    };
    await assert.rejects(
      remember.execute({ ...pref, evidence: "Invented preference" }, signal),
      /latest human/,
    );
    await remember.execute(pref, signal);
    const knowledge = {
      key: "auth.entrypoint",
      scope: "repository",
      kind: "project",
      text: "authorize is the auth entrypoint.",
      evidence: "Source-backed interpretation, not runtime verification.",
      sources: [{ path: file, quote: "function authorize()" }],
    };
    await remember.execute(knowledge, signal);
    assert.equal(
      (await memory.reference("auth authorize", scope)).some(
        (r) => r.kind === "project",
      ),
      true,
    );
    assert.equal(
      (await memory.reference("auth authorize", "another-repo")).some(
        (r) => r.kind === "project",
      ),
      false,
    );
    buffers.set(file, "export function authorize() { return false; }");
    assert.equal(
      (await memory.reference("auth authorize", scope)).some(
        (r) => r.kind === "project",
      ),
      false,
    );
    await assert.rejects(
      remember.execute(
        {
          ...knowledge,
          sources: [{ path: path.join(root, "private.ts"), quote: "secret" }],
        },
        signal,
      ),
      /excluded/,
    );
    await assert.rejects(
      remember.execute(
        { ...knowledge, sources: [{ path: file, quote: "not present" }] },
        signal,
      ),
      /current file/,
    );
    config.memoryEnabled = false;
    memory.changed();
    assert.deepEqual(await memory.reference("functions", scope), []);
    await assert.rejects(remember.execute(pref, signal), /paused/);
    config.memoryEnabled = true;
    config.shareEditorContext = false;
    assert.deepEqual(memory.tools("anything", scope), []);
  } finally {
    memory.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});
