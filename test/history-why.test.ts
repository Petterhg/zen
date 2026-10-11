import test from "node:test";
import assert from "node:assert/strict";
import type { HistoryRecord } from "../extension/src/history/journal.js";
import {
  explainSelection,
  renderReasons,
} from "../extension/src/history/why.js";

function fixture(): HistoryRecord[] {
  const events: [string, Record<string, unknown>][] = [
    ["document.baseline", { text: "a1", version: 1 }],
    ["request.observed", { requestId: "request", input: "Use two" }],
    [
      "provider.request",
      {
        requestId: "request",
        invocationId: "first",
        model: "model",
        provider: "synthetic",
        effectiveEffort: "low",
        body: { private: "withheld" },
      },
    ],
    [
      "provider.response",
      {
        requestId: "request",
        invocationId: "first",
        body: { private: "withheld" },
      },
    ],
    [
      "provider.request",
      {
        requestId: "request",
        invocationId: "retry",
        model: "model",
        retryOf: "first",
        effectiveEffort: "high",
      },
    ],
    [
      "provider.failure",
      { requestId: "request", invocationId: "retry", category: "cancelled" },
    ],
    [
      "proposal.created",
      {
        proposalId: "proposal",
        requestId: "request",
        invocationIds: ["first", "retry"],
        explanation: "Two is required",
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
      { proposalId: "proposal", requestId: "request", version: 2, text: "a2" },
    ],
    [
      "document.changed",
      {
        beforeText: "a2",
        text: "b2",
        beforeVersion: 2,
        version: 3,
        edits: [{ start: 0, end: 1, text: "b" }],
        origin: { writer: "human", operation: "typing" },
      },
    ],
  ];
  return events.map(([type, data], i) => ({
    id: `event-${i}`,
    type,
    sequence: i + 1,
    replicaId: "local",
    previous: "",
    time: "2026-10-11",
    data: { file: "a.ts", ...data },
  }));
}

test("selection explains mixed origins and follows exact request/proposal/attempt edges", () => {
  const reasons = explainSelection(fixture(), "local", "a.ts", "b2", 0, 2)!;
  assert.deepEqual(
    reasons.map((r) => r.origin.writer),
    ["human", "ai"],
  );
  assert.equal(reasons[0].origin.eventId, "event-9");
  assert.equal(reasons[0].request, undefined);
  assert.equal(reasons[1].request, "Use two");
  assert.equal(reasons[1].rationale, "Two is required");
  assert.deepEqual(
    reasons[1].attempts.map((a) => a.effort),
    ["low", "high"],
  );
  assert.equal(reasons[1].attempts[1].retryOf, "first");
  assert.deepEqual(reasons[1].attempts[1].outcomes, ["Failure: cancelled"]);
  assert.equal(JSON.stringify(reasons).includes("withheld"), false);
  assert.equal(
    explainSelection(fixture(), "local", "a.ts", "b2", 1, 2)!.length,
    1,
  );
});

test("stale buffers, other replicas and unrelated nearby evidence cannot supply attribution", () => {
  const records = fixture();
  assert.equal(
    explainSelection(records, "local", "a.ts", "stale", 0, 1),
    undefined,
  );
  assert.equal(
    explainSelection(records, "other", "a.ts", "b2", 0, 2),
    undefined,
  );
  records.push({
    ...records[1],
    id: "wrong",
    replicaId: "other",
    data: { ...records[1].data, input: "Wrong person" },
  });
  assert.equal(
    explainSelection(records, "local", "a.ts", "b2", 1, 2)![0].request,
    "Use two",
  );
  const unaccepted = records.filter((r) => r.type !== "proposal.accepted");
  const reason = explainSelection(unaccepted, "local", "a.ts", "b2", 1, 2)![0];
  assert.equal(reason.origin.writer, "editor_unknown");
  assert.equal(reason.request, undefined);
  assert.equal(reason.rationale, undefined);
  assert.deepEqual(reason.attempts, []);
  assert.throws(
    () => explainSelection(records, "local", "a.ts", "b2", -1, 2),
    /Invalid/,
  );
});

test("rendering treats recorded markup as text and states missing evidence", () => {
  const records = fixture();
  records[1].data.input =
    "[execute](command:evil) <script>evil</script> **claim**";
  const rendered = renderReasons(
    "a.ts",
    explainSelection(records, "local", "a.ts", "b2", 0, 2),
  );
  assert.equal(rendered.includes("[execute](command:evil)"), false);
  assert.equal(rendered.includes("<script>"), false);
  assert.ok(rendered.includes("No voice conversation is claimed"));
  assert.ok(renderReasons("a.ts", undefined).includes("No exact history"));
  assert.ok(renderReasons("a.ts", []).includes("Deleted text history"));
});
