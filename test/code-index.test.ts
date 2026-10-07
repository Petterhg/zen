import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodeChunker } from "../extension/src/code-chunks.js";
import { CodeIndex } from "../extension/src/code-index.js";
import {
  openAIEmbed,
  EMBEDDING_DIMENSIONS,
  type Embed,
} from "../extension/src/embeddings.js";
const grammar = path.resolve(
  import.meta.dirname,
  "../node_modules/tree-sitter-wasms/out",
);
const vector = (i: number) =>
  Array.from({ length: 768 }, (_, j) => Number(i === j));
const signal = () => new AbortController().signal;
test("syntax chunks preserve functions, decorators, class context and source ranges", async () => {
  const c = new CodeChunker(grammar);
  const source =
    "import os\n\nclass Account:\n    @classmethod\n    def authorize(cls, token):\n        return token == 'ok'\n\n    def logout(self):\n        return None\n";
  const chunks = await c.chunks("account.py", source);
  assert.ok(
    chunks.some(
      (x) =>
        x.text.includes("@classmethod") && x.text.includes("def authorize"),
    ),
  );
  assert.ok(
    chunks.some(
      (x) => x.text.includes("logout") && !x.text.includes("authorize"),
    ),
  );
  for (const chunk of chunks)
    assert.equal(
      chunk.text,
      source
        .split("\n")
        .slice(chunk.startLine - 1, chunk.endLine)
        .join("\n"),
    );
  assert.ok(chunks.some((x) => x.header.includes("class Account")));
  const ts = await c.chunks(
    "a.ts",
    "export function hello() { return 1; }\nexport function goodbye() { return 2; }\n",
  );
  assert.ok(ts.some((x) => x.text.includes("hello")));
  assert.ok(ts.some((x) => x.text.includes("goodbye")));
  const fallback = await c.chunks(
    "main.tf",
    'resource "a" "first" {\n  value = 1\n}\nresource "a" "second" {\n value=2\n}\n',
  );
  assert.equal(fallback.length, 2);
  const incomplete = await c.chunks("incomplete.py", "def unfinished(\n");
  assert.ok(incomplete.length);
});
test("real Turso filters before ranking, caches unchanged chunks across reopen, removes files and rejects stale writes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pair-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const embed: Embed = async (texts) => {
    calls += texts.length;
    return texts.map((s) => vector(s.includes("authorize") ? 0 : 1));
  };
  const chunker = new CodeChunker(grammar);
  let db = await CodeIndex.open(directory, embed, chunker);
  t.after(() => db.close());
  await db.update(
    {
      path: "services/auth/a.py",
      service: "services/auth",
      language: "py",
      text: "def authorize():\n    return True\n",
    },
    signal(),
  );
  await db.update(
    {
      path: "services/orders/a.py",
      service: "services/orders",
      language: "py",
      text: "def purchase():\n    return 42\n",
    },
    signal(),
  );
  const results = await db.search("authentication", vector(0), {
    service: "services/orders",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].service, "services/orders");
  assert.equal(
    (
      await db.search("authentication", vector(0), { scope: "services/auth" })
    )[0].path,
    "services/auth/a.py",
  );
  assert.equal(
    (await db.search("authentication", vector(0), { language: "ts" })).length,
    0,
  );
  const before = calls;
  await db.update(
    {
      path: "services/auth/a.py",
      service: "services/auth",
      language: "py",
      text: "\n\ndef authorize():\n    return True\n",
    },
    signal(),
  );
  assert.equal(
    calls,
    before,
    "moving unchanged function should not re-embed it",
  );
  assert.equal((await db.search("authorize", vector(0), {}))[0].startLine, 3);
  await db.close();
  db = await CodeIndex.open(directory, embed, chunker);
  await db.update(
    {
      path: "services/auth/a.py",
      service: "services/auth",
      language: "py",
      text: "def authorize():\n    return True\n",
    },
    signal(),
  );
  assert.equal(calls, before, "persistent cache survives reopening");
  await assert.rejects(
    () => CodeIndex.open(directory, embed, chunker),
    /already owned/,
  );
  let checks = 0;
  const stale = await db.update(
    {
      path: "services/auth/a.py",
      service: "services/auth",
      language: "py",
      text: "def changed():\n    return False\n",
    },
    signal(),
    async () => ++checks < 2,
  );
  assert.equal(stale.stale, true);
  assert.ok(
    (await db.search("authorize", vector(0), {})).some((h) =>
      h.text.includes("authorize"),
    ),
  );
  await db.remove("services/auth/a.py");
  assert.deepEqual(await db.paths(), ["services/orders/a.py"]);
  await assert.rejects(() => db.search("test", [1, 0], {}), /does not match/);
});
test("OpenAI embeddings use one model and dimension space, map indexes, and reject malformed responses", async () => {
  let request: Record<string, unknown> = {};
  const embed = openAIEmbed(async () => "fake", (async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return Response.json({
      data: [
        { index: 1, embedding: vector(1) },
        { index: 0, embedding: vector(0) },
      ],
    });
  }) as typeof fetch);
  const result = await embed(["function", "question"], signal());
  assert.equal(request.model, "text-embedding-3-small");
  assert.equal(request.dimensions, 768);
  assert.equal(result[0][0], 1);
  assert.equal(result[1].length, EMBEDDING_DIMENSIONS);
  const broken = openAIEmbed(async () => "fake", (async () =>
    Response.json({ data: [{ index: 0, embedding: [1] }] })) as typeof fetch);
  await assert.rejects(
    () => broken(["test"], signal()),
    /Invalid embedding response/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => embed(["test"], controller.signal));
});
