import test from "node:test";
import assert from "node:assert/strict";
import { requestBackend, DEFAULT_MODELS } from "../extension/src/backend.js";
import {
  sanitizeEvidence,
  inspectEvidence,
  type ProviderEvidence,
} from "../extension/src/history/evidence.js";
const answer = {
  status: "answer",
  summary: "Verified result",
  speech: "Verified result",
  edits: [],
};
const options = () => ({
  provider: "cerebras" as const,
  model: DEFAULT_MODELS.cerebras,
  apiKey: "fixture-provider-secret",
  history: [{ role: "user" as const, text: "Explain this change" }],
  signal: new AbortController().signal,
});
test("provider evidence matches sanitized assembled messages, preserves settings and excludes credentials/reasoning", async () => {
  const events: ProviderEvidence[] = [];
  const messages: unknown[] = [];
  const result = await requestBackend({
    ...options(),
    effort: "none",
    onEvidence: (event) => {
      events.push(event);
    },
    fetchImpl: (async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      messages.push(wire);
      assert.equal(wire.reasoning_effort, "none");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer fixture-provider-secret",
      );
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify(answer),
              reasoning: "private-thought",
              reasoning_content: "other-private-thought",
            },
            finish_reason: "stop",
          },
        ],
        usage: { total_tokens: 42 },
      });
    }) as typeof fetch,
  });
  assert.equal(result.summary, answer.summary);
  assert.deepEqual(
    events.map((event) => event.type),
    ["provider.request", "provider.response"],
  );
  assert.deepEqual(
    events[0].body,
    sanitizeEvidence(messages[0], [options().apiKey]),
  );
  assert.equal(events[0].invocationId, events[1].invocationId);
  const evidence = JSON.stringify(events);
  assert.equal(evidence.includes("fixture-provider-secret"), false);
  assert.equal(evidence.includes("private-thought"), false);
  assert.equal(events[0].effectiveEffort, "none");
  assert.equal(events[1].status, 200);
  assert.equal(typeof inspectEvidence({ ...events[1] }).body, "string");
  assert.equal(
    JSON.stringify(inspectEvidence({ ...events[1] })).includes(
      "Verified result",
    ),
    false,
  );
});
test("output retry has separate invocation identity and explicit retry edge", async () => {
  const events: ProviderEvidence[] = [];
  let calls = 0;
  await requestBackend({
    ...options(),
    effort: "high",
    onEvidence: (event) => {
      events.push(event);
    },
    fetchImpl: (async () => {
      calls++;
      return Response.json({
        choices: [
          {
            finish_reason: calls === 1 ? "length" : "stop",
            message: {
              content: calls === 1 ? "partial" : JSON.stringify(answer),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  const requests = events.filter((event) => event.type === "provider.request");
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].invocationId, requests[1].invocationId);
  assert.equal(requests[1].retryOf, requests[0].invocationId);
  assert.equal(requests[1].retry, true);
  assert.equal(requests[1].effectiveEffort, "none");
});
test("failed/cancelled calls have a terminal observation and recording errors do not change model results", async () => {
  const events: ProviderEvidence[] = [];
  await assert.rejects(
    requestBackend({
      ...options(),
      onEvidence: (event) => {
        events.push(event);
      },
      fetchImpl: (async () => {
        throw new Error("synthetic network failure");
      }) as typeof fetch,
    }),
    /synthetic network failure/,
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["provider.request", "provider.failure"],
  );
  assert.equal(events[1].category, "transport_failure");
  const controller = new AbortController();
  const cancelled: ProviderEvidence[] = [];
  await assert.rejects(
    requestBackend({
      ...options(),
      signal: controller.signal,
      onEvidence: (event) => {
        cancelled.push(event);
      },
      fetchImpl: (async () => {
        controller.abort();
        throw controller.signal.reason;
      }) as typeof fetch,
    }),
  );
  assert.equal(cancelled.at(-1)?.category, "cancelled");
  let calls = 0;
  const result = await requestBackend({
    ...options(),
    onEvidence: () => {
      throw Error("fixture recorder failure");
    },
    fetchImpl: (async () => {
      calls++;
      return Response.json({
        choices: [{ message: { content: JSON.stringify(answer) } }],
      });
    }) as typeof fetch,
  });
  assert.equal(result.summary, answer.summary);
  assert.equal(calls, 1);
});
test("evidence sanitizer keeps long evidence complete, preserves Together settings and creates a separate derivative", () => {
  const original = {
    reasoning: { enabled: true },
    messages: [
      {
        content: "x".repeat(20000),
        reasoning: "thinking",
        reasoning_content: "thinking again",
      },
    ],
    password: "secret",
    apiKey: "secret",
  };
  const copy = sanitizeEvidence(original) as typeof original;
  assert.equal(copy.messages[0].content.length, 20000);
  assert.deepEqual(copy.reasoning, { enabled: true });
  assert.equal(copy.messages[0].reasoning, "[private reasoning omitted]");
  assert.equal(original.messages[0].reasoning, "thinking");
  assert.equal(
    sanitizeEvidence("<think>hidden</think>answer"),
    "[reasoning-bearing content withheld]",
  );
});
