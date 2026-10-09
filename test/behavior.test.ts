import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FocusTimeline,
  TranscriptHistory,
  createProposal,
  type EditorContext,
} from "../extension/src/core.js";
import { CommandLedger, voiceContent } from "../extension/src/live-protocol.js";
import {
  createLiveSession,
  requestBackend,
  requestInline,
  DEFAULT_MODELS,
} from "../extension/src/backend.js";
import { insideWorkspace, publicWebUrl } from "../extension/src/tool-policy.js";
import { localKey } from "../extension/src/local-keys.js";

const focus: EditorContext = {
  uri: "file:///project/a.ts",
  file: "a.ts",
  version: 3,
  language: "typescript",
  text: "const answer = 1;",
  selection: "answer",
  selectionStart: 6,
  selectionEnd: 12,
  diagnostics: [],
  cursor: { line: 0, character: 12, offset: 12 },
};
test("speech target stays on acknowledged A when navigation to B occurs after the spoken interval", () => {
  const timeline = new FocusTimeline();
  timeline.seed(timeline.record(focus));
  const next = timeline.record({
    ...focus,
    uri: "file:///project/b.ts",
    file: "b.ts",
  });
  timeline.acknowledge(next, 500);
  assert.equal(timeline.resolve(100, 400)?.file, "a.ts");
  assert.equal(timeline.resolve(100, 600)?.focusChanged, true);
  assert.throws(
    () =>
      createProposal(timeline.resolve(100, 600)!, {
        summary: "Edit",
        edits: [{ oldText: "answer", newText: "result" }],
      }),
    /changed during speech/,
  );
});
test("raw fragments cannot leak future text through a merged transcript or reconnect timeline", () => {
  const history = new TranscriptHistory();
  history.beginSession();
  const input = (id: string, text: string, start: number) =>
    history.append({
      type: "session.input_transcript.delta",
      event_id: id,
      delta: text,
      start_ms: start,
      end_ms: start + 40,
    });
  input("a", "Change ", 100);
  input("b", "that function.", 200);
  input("c", " Actually, cancel.", 600);
  assert.equal(
    history
      .snapshot(300)
      .map((e) => e.text)
      .join(""),
    "Change that function.",
  );
  history.beginSession();
  input("a", "Keep the earlier behavior.", 10);
  const resumed = history
    .snapshot(100)
    .map((e) => e.text)
    .join("");
  assert.ok(resumed.includes("Actually, cancel."));
  assert.ok(resumed.includes("Keep the earlier behavior."));
});
test("acknowledgments match commands; failure is not delivery; mute acknowledges only the matching id", () => {
  const ledger = new CommandLedger();
  ledger.track("focus-1", "session.thinking.append", 42);
  assert.equal(
    ledger.receive({
      type: "session.commentary.appended",
      client_event_id: "focus-1",
    }),
    undefined,
  );
  assert.equal(ledger.pendingContext, true);
  assert.equal(
    ledger.receive({ type: "error", error: { client_event_id: "focus-1" } })
      ?.accepted,
    false,
  );
  assert.equal(ledger.pendingContext, false);
  ledger.track("mute", "session.input_audio.mute");
  assert.equal(
    ledger.receive({
      type: "session.input_audio.muted",
      client_event_id: "unrelated",
    }),
    undefined,
  );
  assert.equal(
    ledger.receive({
      type: "session.input_audio.muted",
      client_event_id: "mute",
    })?.accepted,
    true,
  );
  assert.equal(ledger.size, 0);
});
test("startup seeds bounded final conversation and editor reference without provider reasoning", async () => {
  let body: Record<string, unknown> = {};
  await createLiveSession({
    apiKey: "fake",
    sdp: "v=0\ntest",
    voice: "marin",
    instructions: "pair",
    editorContext: "Selected a.ts",
    history: [
      { role: "user", text: "Keep validation." },
      { role: "assistant", text: "Understood." },
    ],
    signal: new AbortController().signal,
    fetchImpl: (async (_u, i) => {
      body = JSON.parse(String(i?.body));
      return Response.json({
        session: { id: "session" },
        transport: { sdp: "answer" },
      });
    }) as typeof fetch,
  });
  const session = body.session as {
    input: { role: string; content: { type: string; text: string }[] }[];
  };
  assert.equal(
    session.input[0].content[0].text,
    "Application editor reference, not a request: Selected a.ts",
  );
  assert.equal(session.input[2].content[0].type, "output_text");
});
test("Cerebras/Together tool loops match results and keep thinking private to the correct provider", async () => {
  for (const provider of ["together", "cerebras"] as const) {
    const requests: Record<string, unknown>[] = [];
    let executions = 0;
    const result = await requestBackend({
      provider,
      model: DEFAULT_MODELS[provider],
      apiKey: "fake",
      history: [{ role: "user", text: "Where is answer used?" }],
      context: focus,
      signal: new AbortController().signal,
      tools: [
        {
          name: "references",
          description: "Find references",
          parameters: { type: "object" },
          execute: async () => {
            executions++;
            return { path: "a.ts", line: 1 };
          },
        },
      ],
      fetchImpl: (async (_u, i) => {
        requests.push(JSON.parse(String(i?.body)));
        return Response.json({
          choices: [
            {
              message:
                requests.length === 1
                  ? {
                      role: "assistant",
                      reasoning: "SECRET_REASONING_TEST_MARKER",
                      tool_calls: [
                        {
                          id: "r1",
                          type: "function",
                          function: { name: "references", arguments: "{}" },
                        },
                      ],
                    }
                  : {
                      content: JSON.stringify({
                        status: "answer",
                        summary: "Used in a.ts:1",
                        speech: "I found one reference.",
                        edits: [],
                      }),
                    },
            },
          ],
        });
      }) as typeof fetch,
    });
    assert.equal(executions, 1);
    assert.equal(result.status, "answer");
    assert.equal(
      requests[0].reasoning_effort,
      provider === "together" ? undefined : "medium",
    );
    assert.equal(
      requests[0].reasoning_format,
      provider === "together" ? undefined : "parsed",
    );
    if (provider === "together")
      assert.deepEqual(requests[0].reasoning, { enabled: true });
    assert.equal(requests[0].response_format, undefined);
    assert.match(JSON.stringify(requests[1].messages), /"tool_call_id":"r1"/);
    assert.equal(
      JSON.stringify(requests[1]).includes("SECRET_REASONING_TEST_MARKER"),
      provider === "together",
    );
    assert.doesNotMatch(JSON.stringify(result), /SECRET_REASONING_TEST_MARKER/);
  }
});
test("cancellation stops waiting for an uninterruptible tool and suppresses continuation", async () => {
  const cancel = new AbortController();
  let calls = 0;
  await assert.rejects(
    requestBackend({
      provider: "together",
      model: DEFAULT_MODELS.together,
      apiKey: "fake",
      history: [],
      signal: cancel.signal,
      tools: [
        {
          name: "read",
          description: "read",
          parameters: {},
          execute: async () => {
            cancel.abort();
            return new Promise(() => {});
          },
        },
      ],
      fetchImpl: (async () => {
        calls++;
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "c",
                    type: "function",
                    function: { name: "read", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
      }) as typeof fetch,
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});
test("inline insertion uses no tools or reasoning and enforces its output contract", async () => {
  let request: Record<string, unknown> = {};
  const value = await requestInline({
    provider: "together",
    model: DEFAULT_MODELS.together,
    apiKey: "fake",
    context: focus,
    signal: new AbortController().signal,
    fetchImpl: (async (_u, i) => {
      request = JSON.parse(String(i?.body));
      return Response.json({
        choices: [{ message: { content: '{"insertion":" + 2"}' } }],
      });
    }) as typeof fetch,
  });
  assert.equal(value, " + 2");
  assert.equal(request.reasoning_effort, undefined);
  assert.deepEqual(request.reasoning, { enabled: false });
  assert.equal(request.tools, undefined);
});
test("workspace reads reject traversal, secret files, and symlinks escaping roots", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "pair-scope-"));
  const root = path.join(temp, "project");
  await mkdir(root);
  try {
    await writeFile(path.join(root, "a.ts"), "hello");
    await writeFile(path.join(temp, "outside.ts"), "private");
    await writeFile(path.join(root, ".env"), "SECRET=test");
    await symlink(path.join(temp, "outside.ts"), path.join(root, "linked.ts"));
    assert.match(
      await insideWorkspace(path.join(root, "a.ts"), [root]),
      /a\.ts$/,
    );
    for (const file of [
      path.join(root, "..", "outside.ts"),
      path.join(root, "linked.ts"),
      path.join(root, ".env"),
    ])
      await assert.rejects(insideWorkspace(file, [root]));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("local .env loading is whitelisted and public page tools reject private destinations", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "pair-keys-"));
  const file = path.join(temp, ".env");
  try {
    await writeFile(
      file,
      'OPENAI_API_KEY="test-only"\nTOGETHER_API_KEY="together-test-only"\nNODE_OPTIONS=bad\n',
    );
    assert.equal(await localKey(file, "OPENAI_API_KEY"), "test-only");
    assert.equal(
      await localKey(file, "TOGETHER_API_KEY"),
      "together-test-only",
    );
    assert.equal(await localKey(file, "NODE_OPTIONS"), undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://foo.internal",
    "https://me:secret@example.com",
  ])
    assert.throws(() => publicWebUrl(url));
  assert.equal(
    publicWebUrl("https://developers.openai.com/"),
    "https://developers.openai.com/",
  );
  assert.ok(
    new TextEncoder().encode(voiceContent("🧑‍💻你好".repeat(400))).length <= 480,
  );
});
