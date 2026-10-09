import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canApplyProposal,
  conciseVoiceContent,
  createProposal,
  parseBackendResult,
  TranscriptHistory,
  type EditorContext,
} from "../extension/src/core.js";
import { createLiveSession, requestBackend } from "../extension/src/backend.js";

const context: EditorContext = {
  uri: "file:///demo.ts",
  file: "demo.ts",
  language: "typescript",
  version: 4,
  text: "const first = 1;\nconst second = 2;",
  selection: "const second = 2;",
  selectionStart: 17,
  selectionEnd: 34,
  diagnostics: [],
};
test("edit matches stay within selected code and preserve offsets", () => {
  const proposal = createProposal(context, {
    summary: "Rename.",
    edits: [{ oldText: "second", newText: "next" }],
  })!;
  assert.deepEqual(
    { start: proposal.start, end: proposal.end, old: proposal.oldText },
    { start: 23, end: 29, old: "second" },
  );
  assert.throws(
    () =>
      createProposal(context, {
        summary: "Bad scope.",
        edits: [{ oldText: "first", newText: "other" }],
      }),
    /unique match/,
  );
});
test("ambiguous matches are never automatically located", () => {
  assert.throws(
    () =>
      createProposal(
        { ...context, selection: "", text: "x x" },
        { summary: "Edit.", edits: [{ oldText: "x", newText: "y" }] },
      ),
    /unique match/,
  );
});
test("new human edits, wrong file, or changed target block proposal acceptance", () => {
  const proposal = createProposal(context, {
    summary: "Rename.",
    edits: [{ oldText: "second", newText: "next" }],
  })!;
  assert.deepEqual(
    [
      canApplyProposal(proposal, context.uri, 4, context.text),
      canApplyProposal(proposal, context.uri, 5, context.text),
      canApplyProposal(proposal, "file:///other.ts", 4, context.text),
      canApplyProposal(
        proposal,
        context.uri,
        4,
        context.text.replace("second", "human"),
      ),
    ],
    [true, false, false, false],
  );
});
test("malformed or multiple edits are rejected", () => {
  for (const content of [
    "{}",
    '{"summary":"ok","edits":[{"oldText":"","newText":""}]}',
    '{"summary":"ok","edits":[{},{}]}',
  ])
    assert.throws(() => parseBackendResult(content));
});
test("transcript deltas preserve spaces, ignore duplicates, and separate speakers", () => {
  const history = new TranscriptHistory();
  history.append({
    type: "session.input_transcript.delta",
    event_id: "1",
    delta: "Keep ",
    start_ms: 100,
    end_ms: 200,
  });
  history.append({
    type: "session.input_transcript.delta",
    event_id: "2",
    delta: "that branch.",
    start_ms: 200,
    end_ms: 400,
  });
  history.append({
    type: "session.input_transcript.delta",
    event_id: "2",
    delta: "that branch.",
    start_ms: 200,
    end_ms: 400,
  });
  history.append({
    type: "session.output_transcript.delta",
    event_id: "3",
    delta: "Okay.",
    start_ms: 500,
    end_ms: 600,
  });
  assert.deepEqual(
    history.snapshot(450).map((entry) => entry.text),
    ["Keep that branch."],
  );
  assert.deepEqual(
    history.snapshot().map((entry) => entry.role),
    ["user", "assistant"],
  );
});
test("voice append content remains bounded even for emoji and CJK", () => {
  const result = conciseVoiceContent("你好🧑‍💻".repeat(600));
  assert.ok(Buffer.byteLength(result, "utf8") <= 480);
  assert.ok(!result.includes("\uFFFD"));
});
test("Live requests use exact model and client delegation, keeping the key off the result", async () => {
  let request: Record<string, unknown> = {};
  const fetchImpl = (async (url, init) => {
    request = {
      url,
      headers: init?.headers,
      body: JSON.parse(String(init?.body)),
    };
    return new Response(
      JSON.stringify({
        session: { id: "live_test" },
        transport: { sdp: "answer" },
        private: "do not forward",
      }),
      { status: 201 },
    );
  }) as typeof fetch;
  const result = await createLiveSession({
    apiKey: "test-secret",
    sdp: "v=0\no=test",
    voice: "marin",
    instructions: "pair",
    signal: new AbortController().signal,
    fetchImpl,
  });
  assert.deepEqual(request.body, {
    session: {
      model: "gpt-live-1",
      instructions: "pair",
      audio: { output: { voice: "marin" } },
      delegation: { type: "client" },
      store: false,
    },
    transport: { type: "webrtc", sdp: "v=0\no=test" },
  });
  assert.deepEqual(result, {
    session: { id: "live_test" },
    transport: { sdp: "answer" },
  });
});
test("provider adapter handles Groq and Cerebras without external tool execution", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"summary":"This returns completed titles.","edits":[]}',
            },
          },
        ],
      }),
    );
  }) as typeof fetch;
  for (const provider of ["together", "cerebras"] as const)
    await requestBackend({
      provider,
      model: "test-model",
      apiKey: "fake",
      history: [{ role: "user", text: "Explain this." }],
      context,
      signal: new AbortController().signal,
      fetchImpl,
    });
  assert.deepEqual(
    calls.map((call) => [call.url, call.body.tools]),
    [
      ["https://api.together.ai/v1/chat/completions", undefined],
      ["https://api.cerebras.ai/v1/chat/completions", undefined],
    ],
  );
});
test("provider failures do not echo their body or credentials into the panel", async () => {
  await assert.rejects(
    requestBackend({
      provider: "together",
      model: "test",
      apiKey: "test-secret",
      history: [],
      signal: new AbortController().signal,
      fetchImpl: (async () =>
        new Response("test-secret in provider error", {
          status: 401,
        })) as typeof fetch,
    }),
    (error) =>
      error instanceof Error &&
      error.message.includes("401") &&
      !error.message.includes("test-secret"),
  );
});
test("cancellation propagates to the provider request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    requestBackend({
      provider: "together",
      model: "test",
      apiKey: "fake",
      history: [],
      signal: controller.signal,
      fetchImpl: (async (_url, init) => {
        init?.signal?.throwIfAborted();
        throw new Error("Unexpected request.");
      }) as typeof fetch,
    }),
    { name: "AbortError" },
  );
});

test("empty files and cursor insertions yield anchored previews without finding an empty substring", () => {
  const result = parseBackendResult(
    JSON.stringify({
      status: "proposal",
      summary: "Add endpoint",
      edits: [{ oldText: "", newText: "app = FastAPI()\n" }],
    }),
  );
  const blank = {
    ...context,
    text: "",
    selection: "",
    selectionStart: 0,
    selectionEnd: 0,
    cursor: { line: 0, character: 0, offset: 0 },
  };
  const proposal = createProposal(blank, result)!;
  assert.equal(proposal.start, 0);
  assert.equal(proposal.end, 0);
  assert.ok(canApplyProposal(proposal, blank.uri, blank.version, ""));
  assert.equal(
    canApplyProposal(proposal, blank.uri, blank.version + 1, "human"),
    false,
  );
  const middle = {
    ...blank,
    text: "beforeafter",
    cursor: { line: 0, character: 6, offset: 6 },
  };
  assert.equal(createProposal(middle, result)!.start, 6);
  assert.throws(() => createProposal(context, result), /unselected cursor/);
  assert.throws(
    () => createProposal({ ...blank, cursor: undefined }, result),
    /unselected cursor/,
  );
  assert.throws(
    () =>
      createProposal(
        { ...blank, cursor: { line: 0, character: 1, offset: 1 } },
        result,
      ),
    /unselected cursor/,
  );
  assert.equal(
    canApplyProposal(
      { ...proposal, start: 10, end: 10 },
      blank.uri,
      blank.version,
      "",
    ),
    false,
  );
  assert.equal(
    canApplyProposal({ ...proposal, start: -1 }, blank.uri, blank.version, ""),
    false,
  );
});
