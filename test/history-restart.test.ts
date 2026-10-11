import test from "node:test";
import assert from "node:assert/strict";
import { projectFile, restartParent } from "../extension/src/history/model.js";
import { explainSelection } from "../extension/src/history/why.js";
import type { HistoryRecord } from "../extension/src/history/journal.js";

function stream(
  replicaId: string,
  entries: [string, Record<string, unknown>][],
): HistoryRecord[] {
  return entries.map(([type, data], i) => ({
    id: `${replicaId}-${i}`,
    replicaId,
    sequence: i + 1,
    type,
    data,
    time: "same",
    previous: "",
  }));
}
const file = "/repo/a.ts";
function original() {
  return stream("first", [
    ["session.started", { checkout: "/repo" }],
    ["document.baseline", { file, text: "a1", version: 1 }],
    ["request.observed", { file, requestId: "task", input: "Use two" }],
    [
      "provider.request",
      {
        file,
        requestId: "task",
        invocationId: "attempt",
        model: "fixture",
        effectiveEffort: "high",
      },
    ],
    [
      "proposal.created",
      {
        file,
        proposalId: "edit",
        requestId: "task",
        invocationIds: ["attempt"],
        explanation: "Required",
        version: 1,
        start: 1,
        end: 2,
        oldText: "1",
        newText: "2",
      },
    ],
    [
      "document.changed",
      {
        file,
        beforeText: "a1",
        text: "a2",
        beforeVersion: 1,
        version: 2,
        edits: [{ start: 1, end: 2, text: "2" }],
        origin: { writer: "editor_unknown", operation: "extension" },
      },
    ],
    [
      "proposal.accepted",
      { file, proposalId: "edit", requestId: "task", version: 2, text: "a2" },
    ],
  ]);
}
test("restart follows explicit ancestry with independent editor versions and later human edits", () => {
  const first = original();
  const parent = restartParent(first, file, "a2", "/repo");
  assert.ok(parent);
  const second = stream("second", [
    ["session.started", { checkout: "/repo" }],
    ["document.baseline", { file, text: "a2", version: 1, parent }],
  ]);
  const all = [...second, ...first];
  const reasons = explainSelection(all, "second", file, "a2", 1, 2)!;
  assert.equal(reasons[0].request, "Use two");
  assert.equal(reasons[0].rationale, "Required");
  assert.equal(reasons[0].attempts[0].model, "fixture");
  assert.equal(reasons[0].origin.replicaId, "first");
  const next = restartParent(all, file, "a2", "/repo");
  assert.equal(next?.replicaId, "second");
  const third = stream("third", [
    ["document.baseline", { file, text: "a2", version: 1, parent: next }],
    [
      "document.changed",
      {
        file,
        beforeText: "a2",
        text: "b2",
        beforeVersion: 1,
        version: 2,
        edits: [{ start: 0, end: 1, text: "b" }],
        origin: { writer: "human", operation: "typing" },
      },
    ],
  ]);
  const mixed = explainSelection(
    [...all, ...third],
    "third",
    file,
    "b2",
    0,
    2,
  )!;
  assert.equal(mixed[0].origin.writer, "human");
  assert.equal(mixed[1].request, "Use two");
  assert.throws(() => projectFile(all, file), /independently/);
});
test("external changes, competing streams, unavailable ancestors and invalid ancestry do not inherit", () => {
  const first = original();
  assert.equal(restartParent(first, file, "a3", "/repo"), undefined);
  assert.equal(restartParent(first, file, "a2", "/other"), undefined);
  const other = stream("other", [
    ["session.started", { checkout: "/repo" }],
    ["document.baseline", { file, text: "a2" }],
  ]);
  assert.equal(
    restartParent([...first, ...other], file, "a2", "/repo"),
    undefined,
  );
  const parent = restartParent(first, file, "a2", "/repo")!;
  const second = stream("second", [
    ["document.baseline", { file, text: "a2", parent }],
  ]);
  assert.equal(projectFile(second, file)?.spans[0].origin.writer, "imported");
  const corrupt = stream("second", [
    [
      "document.baseline",
      { file, text: "a2", parent: { ...parent, digest: "wrong" } },
    ],
  ]);
  assert.equal(
    projectFile(corrupt, file, first)?.spans[0].origin.writer,
    "imported",
  );
  const cycle = stream("cycle", [
    [
      "document.baseline",
      {
        file,
        text: "a2",
        parent: { replicaId: "cycle", eventId: "cycle-0", digest: "wrong" },
      },
    ],
  ]);
  assert.throws(() => projectFile(cycle, file), /ancestry/);
  // Metadata on revoked anchors is withheld even when permitted document ancestry survives.
  const allowed = first.filter(
    (r) => !["request.observed", "provider.request"].includes(r.type),
  );
  const reason = explainSelection(
    [...allowed, ...second],
    "second",
    file,
    "a2",
    1,
    2,
  )![0];
  assert.equal(reason.origin.writer, "ai");
  assert.equal(reason.request, undefined);
  assert.deepEqual(reason.attempts, []);
});
