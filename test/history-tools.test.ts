import test from "node:test";
import assert from "node:assert/strict";
import {
  historyTool,
  historyQuestion,
  changeContext,
} from "../extension/src/history/tools.js";
import { CORE_TOOLS, BUILTIN_TOOLS } from "../extension/src/tool-registry.js";
import type { HistoryRecord } from "../extension/src/history/journal.js";

test("history questions require evidence and the history tool remains main-only", async () => {
  for (const question of [
    "Why did this change?",
    "Who wrote this line?",
    "What changed recently?",
    "Explain the recent edits",
  ])
    assert.equal(historyQuestion(question), true);
  assert.equal(historyQuestion("What does this function do?"), false);
  assert.ok(CORE_TOOLS.includes("change_history"));
  assert.ok(BUILTIN_TOOLS.includes("change_history"));
  let calls = 0;
  const tool = historyTool(async (args) => {
    calls++;
    return args;
  });
  assert.deepEqual(
    await tool.execute(
      { action: "recent", limit: 2 },
      new AbortController().signal,
    ),
    { action: "recent", limit: 2 },
  );
  await assert.rejects(
    tool.execute(
      { action: "recent", limit: 100 },
      new AbortController().signal,
    ),
    /Invalid/,
  );
  await assert.rejects(
    tool.execute({ action: "write" }, new AbortController().signal),
    /Invalid/,
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(tool.execute({ action: "recent" }, cancelled.signal));
  assert.equal(calls, 1);
});

test("event conversation context uses explicit same-replica links and bounded excerpts, never provider bodies or nearby speech", () => {
  const make = (
    type: string,
    data: Record<string, unknown>,
    replicaId = "local",
  ): HistoryRecord => ({
    id: type,
    sequence: 1,
    time: "now",
    previous: "",
    replicaId,
    type,
    data,
  });
  const event = make("worker.change-accepted", {
    requestId: "child",
    runId: "run",
    file: "file",
  });
  const records = [
    event,
    make("request.observed", {
      requestId: "child",
      parentRequestId: "parent",
      input: "x".repeat(2000),
    }),
    make("request.observed", {
      requestId: "parent",
      input: "Original question",
    }),
    make("provider.request", {
      requestId: "child",
      model: "model",
      body: { content: "PRIVATE" },
    }),
    make("voice.transcript.fragment", { body: { text: "NEARBY_SPEECH" } }),
    make(
      "request.observed",
      { requestId: "child", input: "WRONG_PERSON" },
      "other",
    ),
  ];
  const result = changeContext(records, event);
  assert.equal(result.conversationContext.request?.text.length, 1600);
  assert.equal(result.conversationContext.request?.excerpt, true);
  assert.equal(
    result.conversationContext.originatingRequest?.text,
    "Original question",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|NEARBY_SPEECH|WRONG_PERSON/,
  );
  assert.equal(
    changeContext(records, make("document.changed", { file: "file" }))
      .conversationContext.request,
    undefined,
  );
});
