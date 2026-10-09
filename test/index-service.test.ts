import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import type {
  IndexService,
  IndexStatus,
} from "../extension/src/index-service.js";
import { startSharedIndexServer } from "../extension/src/shared-index-server.js";
import { openAIEmbed } from "../extension/src/embeddings.js";
const requireNative = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [
    path.resolve(import.meta.dirname, "../extension/src/index-service.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode", "@tursodatabase/database", "web-tree-sitter"],
  write: false,
});
test("editor integration indexes permitted sources, overlays dirty buffers, excludes ignored/deleted results, and stops when sharing is disabled", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pair-index-service-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pair-index-storage-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "services/auth"), { recursive: true });
  const file = path.join(root, "services/auth/main.py");
  await writeFile(file, "def authorize():\n    return True\n");
  await writeFile(path.join(root, "services/auth/.env"), "SECRET_MARKER=value");
  const events = new Map<string, (event: unknown) => void>();
  const event = (name: string) => (callback: (e: unknown) => void) => {
    events.set(name, callback);
    return { dispose() {} };
  };
  const docs: {
    uri: { scheme: string; fsPath: string };
    isDirty: boolean;
    version: number;
    getText: () => string;
  }[] = [];
  let enabled = true,
    requests = 0;
  let offline = false;
  const mock = {
    workspace: {
      isTrusted: true,
      workspaceFolders: [
        { name: "test-repo", uri: { scheme: "file", fsPath: root } },
      ],
      textDocuments: docs,
      createFileSystemWatcher: () => ({
        dispose() {},
        onDidCreate: event("create"),
        onDidChange: event("change"),
        onDidDelete: event("delete"),
      }),
      onDidChangeTextDocument: event("document"),
      onDidCloseTextDocument: event("close"),
      onDidSaveTextDocument: event("save"),
      onDidChangeWorkspaceFolders: event("folders"),
      onDidChangeConfiguration: event("config"),
    },
    window: { activeTextEditor: undefined },
    env: {
      appRoot: path.resolve(
        import.meta.dirname,
        "../.runtime/VSCodium.app/Contents/Resources/app",
      ),
    },
  };
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    requests++;
    if (offline) throw new Error("Synthetic provider outage");
    await new Promise((r) => setTimeout(r, 80));
    const body = JSON.parse(String(init?.body));
    assert.doesNotMatch(JSON.stringify(body), /SECRET_MARKER/);
    return Response.json({
      data: body.input.map((text: string, index: number) => ({
        index,
        embedding: Array.from({ length: 768 }, (_, i) =>
          Number(i === (text.includes("authorize") ? 0 : 1)),
        ),
      })),
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const central = await mkdtemp(path.join(tmpdir(), "zen-shared-service-"));
  let daemon: Awaited<ReturnType<typeof startSharedIndexServer>> | undefined;
  const shared = {
    directory: central,
    start: async () => {
      daemon = await startSharedIndexServer(central, {
        grammars: path.resolve(
          import.meta.dirname,
          "../extension/dist/grammars",
        ),
        embed: openAIEmbed(async () => "fake"),
        idleMs: 60000,
      });
    },
  };
  const clients: IndexService[] = [];
  t.after(async () => {
    for (const client of clients) await client.dispose();
    await daemon?.close();
    await rm(central, { recursive: true, force: true });
  });
  const mod: { exports: { IndexService?: typeof IndexService } } = {
    exports: {},
  };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    (name: string) => (name === "vscode" ? mock : requireNative(name)),
    mod,
    mod.exports,
  );
  const statuses: IndexStatus[] = [];
  const service = new mod.exports.IndexService!(
    {
      extensionPath: path.resolve(import.meta.dirname, "../extension"),
      globalStorageUri: { fsPath: storage },
    } as never,
    async () => "fake",
    () => enabled,
    (status) => statuses.push({ ...status }),
    shared,
  );
  clients.push(service);
  t.after(() => service.dispose());
  const ready = async () => {
    const deadline = Date.now() + 10000;
    while (
      service.status.state !== "ready" &&
      service.status.state !== "error" &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(service.status.state, "ready", service.status.error);
  };
  await ready();
  assert.equal(service.status.coverageKnown, true);
  assert.ok((service.status.chunks ?? 0) > 0);
  const contender = new mod.exports.IndexService!(
    {
      extensionPath: path.resolve(import.meta.dirname, "../extension"),
      globalStorageUri: { fsPath: storage },
    } as never,
    async () => "fake",
    () => enabled,
    () => {},
    shared,
  );
  clients.push(contender);
  t.after(() => contender.dispose());
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(contender.status.state, "ready");
  assert.equal(contender.status.coverageKnown, true);
  assert.equal(contender.status.files, 1);
  assert.ok(
    (
      (await contender.search(
        { query: "authorize" },
        new AbortController().signal,
      )) as { matches: unknown[] }
    ).matches.length > 0,
  );
  await contender.dispose();

  assert.equal(service.status.files, 1);
  assert.ok(statuses.some((s) => s.state === "scanning"));
  assert.ok(
    statuses.some(
      (s) =>
        s.state === "indexing" &&
        s.total === 1 &&
        s.processed === 0 &&
        s.currentFile === "services/auth/main.py",
    ),
  );
  assert.ok(
    statuses.some(
      (s) => s.state === "ready" && s.processed === 1 && s.embedded > 0,
    ),
  );
  assert.equal(service.status.currentFile, undefined);
  const search = async (query: string) =>
    (await service.search(
      {
        query,
        repository: "test-repo",
        service: "services/auth",
        scope: "test-repo/services/auth",
      },
      new AbortController().signal,
    )) as { matches: { text: string; unsaved?: boolean }[] };
  assert.ok((await search("authorize")).matches[0].text.includes("authorize"));
  const alias = (await service.search(
    { query: "authorize", service: "auth" },
    new AbortController().signal,
  )) as { matches: { text: string }[] };
  assert.ok(alias.matches[0].text.includes("authorize"));
  await assert.rejects(
    service.search(
      { query: "authorize", service: "not-a-service" },
      new AbortController().signal,
    ),
    /Service filter.*not indexed/,
  );
  docs.push({
    uri: { scheme: "file", fsPath: file },
    isDirty: true,
    version: 2,
    getText: () => "def revoke():\n    return False\n",
  });
  const dirty = await search("revoke");
  assert.ok(dirty.matches.some((m) => m.unsaved && m.text.includes("revoke")));
  assert.ok(dirty.matches.every((m) => !m.text.includes("authorize")));
  offline = true;
  assert.ok(
    (await search("revoke offline")).matches.some(
      (m) => m.unsaved && m.text.includes("revoke"),
    ),
    "fresh lexical buffers must work without embeddings",
  );
  offline = false;
  await writeFile(path.join(root, ".pairignore"), "services/auth/\n");
  assert.equal((await search("revoke")).matches.length, 0);
  const before = requests;
  enabled = false;
  service.refresh();
  await assert.rejects(() => search("new request"), /disabled/);
  assert.equal(requests, before);
  enabled = true;
  docs.length = 0;
  await rm(path.join(root, ".pairignore"));
  await rm(file);
  service.refresh();
  await new Promise((r) => setTimeout(r, 1400));
  await ready();
  assert.equal(service.status.files, 0);

  const waiting = new mod.exports.IndexService!(
    {
      extensionPath: path.resolve(import.meta.dirname, "../extension"),
      globalStorageUri: { fsPath: storage },
    } as never,
    async () => "fake",
    () => enabled,
    () => {},
    shared,
  );
  clients.push(waiting);
  t.after(() => waiting.dispose());
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(waiting.status.state, "ready");
  await daemon!.close();
  await service.dispose();
  await new Promise((r) => setTimeout(r, 150));
  const retryDeadline = Date.now() + 13000;
  while (String(waiting.status.state) !== "ready" && Date.now() < retryDeadline)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    waiting.status.state,
    "ready",
    "a connected window automatically restarts the shared owner after it exits",
  );
  assert.equal(waiting.status.coverageKnown, true);
  await waiting.dispose();
});
