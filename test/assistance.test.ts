import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistanceLevel,
  assistancePolicy,
  voiceAssistanceInstructions,
} from "../extension/src/assistance.js";
import { backendSchema } from "../extension/src/backend-schema.js";
import {
  requestBackend,
  requestInline,
  DEFAULT_MODELS,
} from "../extension/src/backend.js";
import { voiceInstructions } from "../extension/src/prompts.js";
interface RequestBody {
  messages: { content: string }[];
  response_format: {
    json_schema: { schema: { properties: { edits: { maxItems: number } } } };
  };
}
const context = {
  uri: "file:///demo/hello.py",
  file: "hello.py",
  language: "python",
  version: 1,
  text: "",
  selection: "",
  selectionStart: 0,
  selectionEnd: 0,
  diagnostics: [],
  cursor: { line: 0, character: 0, offset: 0 },
};
const proposal = (lines: number) => ({
  status: "proposal",
  summary: "Preview ready",
  speech: "Preview ready",
  edits: [
    {
      oldText: "",
      newText: Array.from(
        { length: lines },
        (_, i) => `value_${i} = ${i}`,
      ).join("\n"),
    },
  ],
});
const answer = {
  status: "answer",
  summary: "Type one import",
  speech:
    "Type from fastapi import FastAPI on line one, then tell me when ready.",
  edits: [],
};
function options(
  level: number,
  responses: unknown[],
  bodies: RequestBody[] = [],
) {
  return {
    provider: "cerebras" as const,
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    assistanceLevel: level,
    history: [
      { role: "user" as const, text: "Write a small FastAPI application." },
    ],
    context,
    signal: new AbortController().signal,
    fetchImpl: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { content: JSON.stringify(responses.shift()) } }],
      });
    }) as typeof fetch,
  };
}
test("pairing defaults to a small step and Live updates fit without truncation at every level", () => {
  assert.equal(assistanceLevel(undefined), 25);
  assert.equal(assistanceLevel(NaN), 25);
  assert.equal(assistanceLevel(-5), 0);
  assert.equal(assistanceLevel(105), 100);
  assert.deepEqual(
    [0, 25, 50, 75, 100].map((n) => assistancePolicy(n).maxLines),
    [0, 250, 500, 750, 1000],
  );
  for (let n = 0; n <= 100; n++) {
    assert.ok(
      Buffer.byteLength(voiceAssistanceInstructions(n)) <= 480,
      String(n),
    );
    assert.ok(
      voiceInstructions(true, n).includes(`Current pairing style ${n}/100`),
    );
  }
});
test("guide mode forbids proposals and retries a noncompliant provider without exposing code", async () => {
  assert.equal(backendSchema(0).properties.edits.maxItems, 0);
  assert.ok(!backendSchema(0).properties.status.enum.includes("proposal"));
  const bodies: RequestBody[] = [];
  assert.equal(
    (await requestBackend(options(0, [answer], bodies))).status,
    "answer",
  );
  assert.ok(bodies[0].messages[0].content.includes("Return no edits"));
  assert.equal(
    bodies[0].response_format.json_schema.schema.properties.edits.maxItems,
    0,
  );
  const recovered = await requestBackend(
    options(0, [proposal(1), proposal(1), proposal(1)]),
  );
  assert.equal(recovered.edits.length, 0);
});
test("small-step previews are repaired once without truncating code; full drafting permits larger previews", async () => {
  const bodies: RequestBody[] = [];
  const result = await requestBackend(
    options(1, [proposal(20), proposal(3)], bodies),
  );
  assert.equal(result.edits[0].newText.split("\n").length, 3);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1].messages[0].content.includes("at most 10 changed lines"));
  assert.equal(
    (
      await requestBackend(
        options(1, [proposal(20), proposal(20), proposal(20)]),
      )
    ).edits.length,
    0,
  );
  assert.equal(
    (await requestBackend(options(100, [proposal(80)]))).edits[0].newText.split(
      "\n",
    ).length,
    80,
  );
});
test("tool finalization retains coaching policy instead of demanding a generated implementation", async () => {
  const bodies: RequestBody[] = [];
  const opts = options(0, ["Use an import first.", answer], bodies);
  const result = await requestBackend({
    ...opts,
    tools: [
      {
        name: "read_file",
        description: "Read",
        parameters: {},
        execute: async () => ({ text: "" }),
      },
    ],
  });
  assert.equal(result.edits.length, 0);
  assert.equal(bodies.length, 2);
  assert.ok(
    bodies[1].messages
      .at(-1)!
      .content.includes("guide mode returning answer with no edits"),
  );
});
test("voice-only mode suppresses even explicit inline requests without calling a provider", async () => {
  const bodies: RequestBody[] = [];
  assert.equal(
    await requestInline(options(0, [{ insertion: "unwanted code" }], bodies)),
    "",
  );
  assert.equal(bodies.length, 0);
  await assert.rejects(
    requestInline(options(25, [{ insertion: "one\ntwo" }])),
    /Invalid inline suggestion/,
  );
  assert.equal(
    await requestInline(
      options(25, [{ insertion: "from fastapi import FastAPI" }]),
    ),
    "from fastapi import FastAPI",
  );
});
