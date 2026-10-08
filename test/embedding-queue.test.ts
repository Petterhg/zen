import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodeIndex } from "../extension/src/code-index.js";
import { CodeChunker } from "../extension/src/code-chunks.js";
import { SharedIndexCoordinator } from "../extension/src/shared-index-coordinator.js";

test("reopened coordinator reconciles and drains overdue durable embedding jobs", async (t) => {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "zen-queue-reopen-")),
  );
  const root = path.join(directory, "repo");
  await mkdir(root);
  const text = "def durable_pending():\n    return True\n";
  await writeFile(path.join(root, "main.py"), text);
  let calls = 0;
  const embed = async (texts: string[]) => {
    calls += texts.length;
    return texts.map(() =>
      Array.from({ length: 768 }, (_, i) => Number(i === 0)),
    );
  };
  const grammar = path.resolve(
    import.meta.dirname,
    "../node_modules/tree-sitter-wasms/out",
  );
  let index = await CodeIndex.open(
    path.join(directory, "database"),
    embed,
    new CodeChunker(grammar),
  );
  await index.update(
    {
      checkout: root,
      repository: "repo",
      path: "main.py",
      language: "py",
      service: ".",
      text,
    },
    new AbortController().signal,
    undefined,
    embed,
    true,
    Date.now() - 61 * 60000,
  );
  await index.close();
  index = await CodeIndex.open(
    path.join(directory, "database"),
    embed,
    new CodeChunker(grammar),
  );
  const coordinator = new SharedIndexCoordinator(
    index,
    () => embed,
    () => {},
  );
  t.after(async () => {
    await coordinator.close();
    await rm(directory, { recursive: true, force: true });
  });
  await coordinator.register(
    "window",
    [{ path: root, name: "repo" }],
    "fake",
    "rg",
  );
  const deadline = Date.now() + 5000;
  while (
    coordinator.statuses("window")[0].state !== "ready" &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(coordinator.statuses("window")[0].state, "ready");
  assert.equal(
    calls,
    1,
    "unchanged reconciliation must retain overdue deadline and embed without another 30-minute delay",
  );
  assert.equal(coordinator.statuses("window")[0].pendingEmbeddings, 0);
  assert.deepEqual(await index.pending(root), []);
});
