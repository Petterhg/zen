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

test("saved lexical delta shadows vectors, persists deadlines, coalesces saves and flushes latest source", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "zen-deferred-index-"));
  let calls = 0;
  const embed: Embed = async (texts) => {
    calls += texts.length;
    return texts.map(() => vector(0));
  };
  let index = await CodeIndex.open(directory, embed, new CodeChunker(grammar));
  t.after(async () => {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  });
  const file = {
    checkout: "repo",
    repository: "repo",
    path: "services/a/main.py",
    service: "services/a",
    language: "py",
    text: "def original():\n    return 1\n",
  };
  await index.update(file, signal());
  assert.equal(calls, 1);
  file.text = "def newest_name():\n    return 2\n";
  await index.update(file, signal(), undefined, embed, true, 1000);
  assert.equal(calls, 1, "lexical staging must not invoke embeddings");
  assert.equal(
    (await index.search("newest_name", [], { checkout: "repo" })).length,
    1,
  );
  assert.equal(
    (await index.search("unrelated", vector(0), { checkout: "repo" })).length,
    0,
    "old vectors must be shadowed, even if highly similar",
  );
  assert.equal(
    (await index.search("original", [], { checkout: "repo" })).length,
    0,
  );
  assert.equal(
    (
      await index.search("newest_name", [], {
        checkout: "repo",
        service: "services/b",
      })
    ).length,
    0,
  );
  await index.update(file, signal(), undefined, embed, true, 5000);
  assert.deepEqual(
    await index.pending("repo"),
    [{ path: file.path, firstChanged: 1000, lastChanged: 1000 }],
    "unchanged rescans must not postpone work",
  );
  file.text = "def newest_name():\n    return 3\n";
  await index.update(file, signal(), undefined, embed, true, 6000);
  await index.close();
  index = await CodeIndex.open(directory, embed, new CodeChunker(grammar));
  assert.deepEqual(await index.pending("repo"), [
    { path: file.path, firstChanged: 1000, lastChanged: 6000 },
  ]);
  await assert.rejects(
    index.update(file, signal(), undefined, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal((await index.pending("repo")).length, 1);
  assert.match(
    (await index.search("newest_name", [], { checkout: "repo" }))[0].text,
    /return 3/,
  );
  const stale = await index.update(file, signal(), async () => false, embed);
  assert.equal(stale.stale, true);
  assert.equal((await index.pending("repo")).length, 1);
  await index.update(file, signal());
  assert.equal(calls, 2);
  assert.deepEqual(await index.pending("repo"), []);
  assert.equal(
    (await index.search("unrelated", vector(0), { checkout: "repo" })).length,
    1,
  );
  file.text += "# pending again\n";
  await index.update(file, signal(), undefined, embed, true);
  await index.remove(file.path, "repo");
  assert.deepEqual(await index.pending("repo"), []);
  assert.deepEqual(
    await index.search("newest_name", [], { checkout: "repo" }),
    [],
  );
});

test("lexical ranking includes highly relevant late chunks and reverts reuse cached vectors immediately", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "zen-lexical-rank-"));
  let calls = 0;
  const embed: Embed = async (texts) => {
    calls += texts.length;
    return texts.map(() => vector(0));
  };
  const index = await CodeIndex.open(
    directory,
    embed,
    new CodeChunker(grammar),
  );
  t.after(async () => {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  });
  const file = {
    checkout: "repo",
    path: "main.py",
    language: "py",
    service: ".",
    text:
      Array.from(
        { length: 210 },
        (_, i) => `def helper_${i}():\n    return "needle"\n`,
      ).join("\n") + '\ndef needle():\n    return "most relevant"\n',
  };
  await index.update(file, signal(), undefined, embed, true);
  const hits = await index.search("needle", [], { checkout: "repo" });
  assert.equal(
    hits[0].symbol,
    "needle",
    "rank all lexical matches before limiting candidates",
  );
  assert.equal(calls, 0);
  const small = {
    ...file,
    path: "small.py",
    text: "def cached():\n    return 1\n",
  };
  await index.update(small, signal());
  await index.update(
    { ...small, text: "def temporary():\n    return 2\n" },
    signal(),
    undefined,
    embed,
    true,
  );
  assert.equal((await index.pending("repo")).length, 2);
  await index.update(small, signal(), undefined, embed, true);
  assert.equal(calls, 1);
  assert.equal(
    (await index.pending("repo")).length,
    1,
    "fully cached reverts need no delay",
  );
  assert.equal(
    (
      await index.search("cached", vector(0), {
        checkout: "repo",
        scope: "small.py",
      })
    )[0].symbol,
    "cached",
  );
});
