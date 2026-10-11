import test from "node:test";
import assert from "node:assert/strict";
import { replacementLineage } from "../extension/src/history/lineage.js";
import {
  applyEdits,
  baseline,
  projectFile,
} from "../extension/src/history/model.js";
import { evidenceDigest } from "../extension/src/history/evidence.js";
import { explainSelection } from "../extension/src/history/why.js";
import type { HistoryRecord } from "../extension/src/history/journal.js";

test("bounded worker comparison preserves boundary origins, Unicode and exact reconstruction", () => {
  for (const [before, after] of [
    ["a1z", "a2z"],
    ["a😀z", "a🚀z"],
    ["prefix", "prefix tail"],
    ["abc", "ac"],
    ["", "new"],
    ["same", "same"],
  ]) {
    const lineage = replacementLineage(before, after);
    assert.equal(
      applyEdits(baseline(before), lineage.edits, {
        writer: "ai",
        operation: "test",
      }).text,
      after,
    );
    assert.equal(lineage.certain, true);
    for (const edit of lineage.edits) {
      assert.ok(
        edit.start === 0 || !/[\uD800-\uDBFF]/.test(before[edit.start - 1]),
      );
      assert.ok(
        edit.end === 0 || !/[\uD800-\uDBFF]/.test(before[edit.end - 1]),
      );
    }
  }
  for (const [before, after] of [
    ["XabY", "YbaX"],
    ["x".repeat(1000), "y".repeat(1000)],
  ]) {
    const lineage = replacementLineage(before, after);
    assert.equal(lineage.certain, false);
    assert.equal(
      applyEdits(baseline(before), lineage.edits, {
        writer: "editor_unknown",
        operation: "ambiguous",
      }).text,
      after,
    );
  }
});

function records(): HistoryRecord[] {
  const rows: [string, string, Record<string, unknown>][] = [
    ["document.baseline", "target", { text: "a1z", version: 1 }],
    [
      "request.observed",
      "anchor",
      { requestId: "parent", input: "Fix the service" },
    ],
    [
      "request.observed",
      "anchor",
      {
        requestId: "child",
        parentRequestId: "parent",
        input: "Use two in target",
      },
    ],
    [
      "worker.started",
      "anchor",
      {
        runId: "run",
        agentId: "implementer",
        requestId: "child",
        parentRequestId: "parent",
      },
    ],
    [
      "provider.request",
      "anchor",
      {
        requestId: "child",
        invocationId: "attempt",
        provider: "together",
        model: "synthetic",
        effectiveEffort: "high",
        body: "withheld",
      },
    ],
    [
      "worker.change-prepared",
      "target",
      {
        changeSetId: "changes",
        runId: "run",
        requestId: "child",
        beforeVersion: 1,
        beforeDigest: evidenceDigest("a1z"),
        afterDigest: evidenceDigest("a2z"),
      },
    ],
    [
      "document.changed",
      "target",
      {
        beforeText: "a1z",
        text: "a2z",
        beforeVersion: 1,
        version: 2,
        edits: [{ start: 0, end: 3, text: "a2z" }],
        origin: { writer: "editor_unknown", operation: "extension" },
      },
    ],
    [
      "worker.change-accepted",
      "target",
      {
        changeSetId: "changes",
        runId: "run",
        requestId: "child",
        beforeVersion: 1,
        version: 2,
        afterDigest: evidenceDigest("a2z"),
      },
    ],
  ];
  return rows.map(([type, file, data], i) => ({
    type,
    id: String(i),
    sequence: i + 1,
    replicaId: "local",
    time: "now",
    previous: "",
    data: { file, ...data },
  }));
}

test("explicit worker buffer proof yields changed-character lineage and follows permitted parent/attempt links", () => {
  const events = records();
  assert.deepEqual(
    projectFile(events, "target")!.spans.map((s) => s.origin.writer),
    ["imported", "ai", "imported"],
  );
  const reason = explainSelection(events, "local", "target", "a2z", 1, 2)![0];
  assert.equal(reason.worker, "implementer");
  assert.equal(reason.request, "Use two in target");
  assert.equal(reason.parentRequest, "Fix the service");
  assert.equal(reason.attempts[0].model, "synthetic");
  const restricted = explainSelection(
    events.filter((r) => r.data.file === "target"),
    "local",
    "target",
    "a2z",
    1,
    2,
  )![0];
  assert.equal(restricted.request, undefined);
  assert.equal(restricted.parentRequest, undefined);
  assert.deepEqual(restricted.attempts, []);
});

test("missing, stale, mismatched or unverified worker proof never assigns AI origin", () => {
  const cases = [
    records().filter((r) => r.type !== "worker.change-prepared"),
    records().filter((r) => r.type !== "worker.change-accepted"),
    records().map((r) =>
      r.type === "worker.change-accepted"
        ? { ...r, type: "worker.change-unverified" }
        : r,
    ),
    records().map((r) =>
      r.type === "worker.change-prepared"
        ? { ...r, data: { ...r.data, beforeDigest: "wrong" } }
        : r,
    ),
    records().map((r) =>
      r.type === "worker.change-accepted"
        ? { ...r, data: { ...r.data, runId: "other" } }
        : r,
    ),
  ];
  const reopened = records();
  reopened[7].sequence = 10;
  reopened.push({
    ...reopened[0],
    id: "reopened",
    sequence: 9,
    data: { file: "target", text: "a2z", version: 2 },
  });
  cases.push(reopened);
  for (const events of cases)
    assert.ok(
      projectFile(events, "target")!.spans.every(
        (s) => s.origin.writer !== "ai",
      ),
    );
  const events = records();
  events.push({
    ...events[6],
    id: "later",
    sequence: 9,
    data: {
      file: "target",
      beforeText: "a2z",
      text: "a3z",
      beforeVersion: 2,
      version: 3,
      edits: [{ start: 1, end: 2, text: "3" }],
      origin: { writer: "human", operation: "typing" },
    },
  });
  assert.equal(
    explainSelection(events, "local", "target", "a3z", 1, 2)![0].origin.writer,
    "human",
  );
});
