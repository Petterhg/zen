import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { connect } from "@tursodatabase/database";
import {
  HistoryJournal,
  type KeyVault,
} from "../extension/src/history/journal.js";
import { project, gitRoot } from "../extension/src/history/project.js";
import {
  baseline,
  applyEdits,
  nativeOrigin,
} from "../extension/src/history/model.js";
function vault(): KeyVault {
  const keys = new Map<string, string>();
  return {
    get: async (key) => keys.get(key),
    store: async (key, value) => {
      keys.set(key, value);
    },
  };
}
test("history initialization is idempotent on an unborn Git root and rejects symlink metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-history-project-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await mkdir(path.join(root, "src"));
    assert.equal(await gitRoot(root), await gitRoot(path.join(root, "src")));
    const first = await project(root, true);
    assert.deepEqual(await project(root, true), first);
    const file = path.join(root, ".zen/project.json");
    await rm(file);
    await writeFile(path.join(root, "outside.json"), JSON.stringify(first));
    await symlink(path.join(root, "outside.json"), file);
    await assert.rejects(project(root, true), /Unsafe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Turso journals encrypt complete events, survive restart and permit separate writers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-history-store-")),
    keys = vault();
  const directory = path.join(root, "repo");
  try {
    const a = await HistoryJournal.create(directory, "repo-id", keys);
    const b = await HistoryJournal.create(directory, "repo-id", keys);
    const mutable = {
      file: "secret-service.py",
      input: "private voice request",
      text: "private source text",
    };
    const pending = a.append("request", mutable);
    mutable.input = "changed after capture";
    await Promise.all([pending, b.append("edit", { text: "other writer" })]);
    assert.equal(a.status.durable, 1);
    const live = await HistoryJournal.read(directory, "repo-id", keys);
    assert.equal(live.length, 2);
    assert.equal(
      live.find((r) => r.type === "request")?.data.input,
      "private voice request",
    );
    await Promise.all([a.close(), b.close()]);
    assert.deepEqual(
      await HistoryJournal.read(directory, "repo-id", keys),
      live,
    );
    for (const file of await readdir(directory)) {
      const bytes = await readFile(path.join(directory, file));
      assert.equal(bytes.includes(Buffer.from("private voice request")), false);
      assert.equal(bytes.includes(Buffer.from("secret-service.py")), false);
    }
    await assert.rejects(
      HistoryJournal.read(directory, "different-repo", keys),
    );
    await assert.rejects(
      HistoryJournal.read(directory, "repo-id", vault()),
      /unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("journal rejects corruption, missing middle events and oversized records without silent continuation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-history-failure-")),
    keys = vault();
  try {
    const a = await HistoryJournal.create(path.join(root, "a"), "repo", keys);
    await a.append("a", {});
    await a.append("b", {});
    await a.append("c", {});
    await a.close();
    const file = path.join(root, "a", `${a.id}.db`),
      db = await connect(file);
    await db.run("DELETE FROM events WHERE sequence = 2");
    await db.close();
    await assert.rejects(
      HistoryJournal.read(path.join(root, "a"), "repo", keys),
      /integrity/,
    );
    const b = await HistoryJournal.create(path.join(root, "b"), "repo", keys);
    await assert.rejects(
      b.append("too-large", { text: "x".repeat(4 * 1024 * 1024) }),
      /limit/,
    );
    await assert.rejects(b.append("later", {}), /limit/);
    assert.equal(b.status.durable, 0);
    await b.close();
    const c = await HistoryJournal.create(path.join(root, "c"), "repo", keys);
    await c.append("a", {});
    await c.close();
    const corrupt = await connect(path.join(root, "c", `${c.id}.db`));
    await corrupt.run("UPDATE events SET body = ?", "broken");
    await corrupt.close();
    await assert.rejects(
      HistoryJournal.read(path.join(root, "c"), "repo", keys),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("mixed human/AI ranges preserve an independent character attribution oracle", () => {
  const human = { writer: "human", operation: "typing" } as const;
  const ai = {
    writer: "ai",
    operation: "accepted",
    requestId: "r",
    proposalId: "p",
  } as const;
  let state = baseline("abc😀xyz");
  const oracle = Array.from({ length: state.text.length }, () => "imported");
  for (const [edits, origin] of [
    [[{ start: 3, end: 5, text: "HI" }], ai],
    [
      [
        { start: 0, end: 1, text: "human" },
        { start: 7, end: 8, text: "!" },
      ],
      human,
    ],
    [[{ start: 2, end: 7, text: "" }], human],
  ] as const) {
    for (const edit of [...edits].sort((a, b) => b.start - a.start))
      oracle.splice(
        edit.start,
        edit.end - edit.start,
        ...Array(edit.text.length).fill(origin.writer),
      );
    state = applyEdits(state, [...edits], origin);
    assert.equal(state.text.length, oracle.length);
    const actual = state.spans.flatMap((span) =>
      Array(span.end - span.start).fill(span.origin.writer),
    );
    assert.deepEqual(actual, oracle);
  }
  assert.throws(
    () =>
      applyEdits(
        state,
        [
          { start: 0, end: 2, text: "a" },
          { start: 1, end: 3, text: "b" },
        ],
        ai,
      ),
    /overlapping/,
  );
  assert.equal(nativeOrigin("cursor", "type").writer, "human");
  assert.equal(nativeOrigin("cursor", "paste").writer, "editor_unknown");
  assert.equal(nativeOrigin("inlineCompletionAccept").writer, "editor_unknown");
  assert.equal(nativeOrigin("cursor", "type", "undo").writer, "editor_unknown");
  assert.equal(nativeOrigin().writer, "editor_unknown");
});

test("history refuses insecure storage and unverified keys without writing plaintext", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zen-history-security-"));
  try {
    const directory = path.join(root, "public");
    await mkdir(directory, { mode: 0o755 });
    await assert.rejects(
      HistoryJournal.create(directory, "repo", vault()),
      /private/,
    );
    const link = path.join(root, "linked");
    await symlink(directory, link);
    await assert.rejects(
      HistoryJournal.create(link, "repo", vault()),
      /private/,
    );
    const badVault: KeyVault = {
      get: async () => undefined,
      store: async () => {},
    };
    const noKey = path.join(root, "no-key");
    await assert.rejects(
      HistoryJournal.create(noKey, "repo", badVault),
      /verified/,
    );
    assert.deepEqual(await readdir(noKey), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit acceptance links a mutation; unrelated same-text edits are not reattributed", async () => {
  const { projectFile } = await import("../extension/src/history/model.js");
  const record = (
    sequence: number,
    type: string,
    data: Record<string, unknown>,
  ) => ({
    sequence,
    type,
    data,
    replicaId: "replica",
    id: String(sequence),
    time: "",
    previous: "",
  });
  const records = [
    record(1, "document.baseline", { file: "a", text: "x1", version: 1 }),
    record(2, "proposal.created", {
      file: "a",
      proposalId: "p",
      requestId: "r",
      version: 1,
      start: 1,
      end: 2,
      oldText: "1",
      newText: "2",
    }),
    record(3, "document.changed", {
      file: "a",
      beforeVersion: 1,
      version: 2,
      beforeText: "x1",
      text: "x2",
      edits: [{ start: 1, end: 2, text: "2" }],
      origin: nativeOrigin(),
    }),
  ];
  assert.equal(
    projectFile(records, "a")?.spans.at(-1)?.origin.writer,
    "editor_unknown",
  );
  records.push(
    record(4, "proposal.accepted", {
      file: "a",
      proposalId: "p",
      requestId: "r",
      version: 2,
      text: "x2",
    }),
  );
  assert.equal(projectFile(records, "a")?.spans.at(-1)?.origin.requestId, "r");
  records.push(
    record(5, "document.changed", {
      file: "a",
      beforeVersion: 2,
      version: 3,
      beforeText: "x2",
      text: "y2",
      edits: [{ start: 0, end: 1, text: "y" }],
      origin: { writer: "human", operation: "typing" },
    }),
  );
  assert.deepEqual(
    projectFile(records, "a")?.spans.map((s) => s.origin.writer),
    ["human", "ai"],
  );
  assert.throws(
    () => projectFile([...records, { ...records[0], replicaId: "other" }], "a"),
    /replica/,
  );
});
