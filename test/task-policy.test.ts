import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideEffort,
  quickQuestion,
  questionSymbol,
  webResearchForbidden,
  providerDiagnostic,
} from "../extension/src/task-policy.js";
import { RequestTargets } from "../extension/src/request-target.js";
import { requestBackend, DEFAULT_MODELS } from "../extension/src/backend.js";
import { explorationTool } from "../extension/src/exploration.js";
import {
  editorVoiceContext,
  canApplyProposal,
  createProposal,
} from "../extension/src/core.js";
import { assistanceViolation } from "../extension/src/assistance.js";
const context = {
  uri: "file:///a.py",
  file: "a.py",
  language: "python",
  version: 3,
  text: "app = FastAPI()\n",
  selection: "",
  selectionStart: 15,
  selectionEnd: 15,
  cursor: { line: 0, character: 15, offset: 15 },
  diagnostics: [],
};
const base = {
  provider: "cerebras" as const,
  model: DEFAULT_MODELS.cerebras,
  apiKey: "fake",
  signal: new AbortController().signal,
};
test("only narrow conversational questions skip the remote reasoning router", () => {
  assert.equal(
    questionSymbol("Could you please what does authenticate_api() do?"),
    "authenticate_api",
  );
  assert.equal(questionSymbol("What does this do?"), undefined);
  assert.equal(questionSymbol("Explain this file"), undefined);
  for (const text of [
    "Hello!",
    "Explain this file.",
    "Please describe the selected function?",
    "What does this method do?",
    "What does authenticate_api do?",
    "What file am I in?",
    "Can you explain this file?",
    "What does this do?",
  ])
    assert.equal(quickQuestion(text), true, text);
  for (const text of [
    "Explain this service",
    "Explain this file and all downstream effects",
    "What does this function do if two requests race?",
    "Explore services/gateway",
    "Why does this function fail?",
    "Fix this line",
    "Try again",
    "Compare the current file with the deployed version",
    "Remember that I prefer small functions",
    "Vad gör tjänsten?",
  ])
    assert.equal(quickQuestion(text), false, text);
});
test("locally captured target survives navigation; completed human line is visible without an ACK", () => {
  const targets = new RequestTargets();
  targets.append({ start_ms: 100, end_ms: 300, delta: "implement" }, context);
  targets.append(
    { start_ms: 310, end_ms: 600, delta: " a function" },
    { ...context, uri: "file:///b.py" },
  );
  const captured = targets.resolve(600)!.context!;
  assert.equal(captured.uri, context.uri);
  const proposal = createProposal(captured, {
    status: "proposal",
    summary: "Preview",
    edits: [{ oldText: "", newText: "# preview" }],
  })!;
  assert.ok(
    canApplyProposal(proposal, context.uri, context.version, context.text),
  );
  assert.ok(
    !canApplyProposal(
      proposal,
      context.uri,
      context.version + 1,
      context.text + "# human change",
    ),
  );
  targets.endTurn();
  const completed = {
    ...context,
    version: 4,
    text: "app = FastAPI(title='Demo')\n",
    cursor: { line: 0, character: 26, offset: 26 },
  };
  targets.append({ start_ms: 650, end_ms: 800, delta: "Done" }, completed);
  assert.equal(targets.resolve(800)!.context!.version, 4);
  assert.match(editorVoiceContext(completed), /FastAPI\(title='Demo'\)/);
  targets.reset();
  assert.equal(targets.resolve(800), undefined);
});
test("Decisions routes effort and safely falls back on refusal, HTTP failure and cancellation", async () => {
  const input = {
    apiKey: "fake",
    history: [{ role: "user" as const, text: "trace the dependency graph" }],
    signal: base.signal,
  };
  assert.equal(
    await decideEffort({
      ...input,
      fetchImpl: (async (_u, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "gpt-6-luna");
        assert.equal(body.questions[0].name, "effort");
        return Response.json({
          answers: [
            {
              type: "choice",
              name: "effort",
              choice: "high",
              confidence: 0.99,
            },
          ],
        });
      }) as typeof fetch,
    }),
    "high",
  );
  for (const response of [
    Response.json({ answers: [{ type: "refusal", name: "effort" }] }),
    new Response("secret", { status: 403 }),
  ]) {
    assert.equal(
      await decideEffort({
        ...input,
        fetchImpl: (async () => response) as typeof fetch,
      }),
      "medium",
    );
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    decideEffort({
      ...input,
      signal: controller.signal,
      fetchImpl: (async () => {
        throw Error("aborted");
      }) as typeof fetch,
    }),
  );
});
test("provider diagnostics classify invalid requests without leaking echoed secrets", async () => {
  const d = await providerDiagnostic(
    Response.json({
      error: {
        message: "max_tokens exceeds limit. secret sk-sample",
        param: "max_tokens",
        type: "invalid_request_error",
      },
    }),
  );
  assert.equal(d.category, "output_parameter");
  assert.equal(d.param, "max_tokens");
  assert.ok(!JSON.stringify(d).includes("sk-sample"));
});
test("backend accepts large evidence, one canonical answer and current acceptance state", async () => {
  const result = await requestBackend({
    ...base,
    assistanceLevel: 100,
    context,
    taskState: { status: "accepted" },
    history: [
      { role: "user", text: "Explain FastAPI title" },
      { role: "assistant", text: "evidence ".repeat(10000) },
    ],
    fetchImpl: (async (_u, init) => {
      const body = JSON.parse(String(init?.body));
      assert.ok(JSON.stringify(body.messages).length > 56000);
      assert.equal(body.max_tokens, 32768);
      assert.match(body.messages.at(-1).content, /accepted/);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "answer",
                summary: "The title labels your API documentation.",
                speech: "Accept the old preview now",
                edits: [],
              }),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(result.speech, result.summary);
});
test("unchanged replacement lines do not consume the preview allowance", () => {
  const unchanged = "# unchanged\n".repeat(1000);
  assert.equal(
    assistanceViolation(
      {
        status: "proposal",
        summary: "One change",
        edits: [{ oldText: unchanged + "old()", newText: unchanged + "new()" }],
      },
      1,
    ),
    undefined,
  );
});
test("explorer has an isolated conversation, excludes mutation/recursion, and returns verified evidence", async () => {
  let calls = 0,
    mutations = 0;
  const tool = explorationTool({
    ...base,
    context,
    tools: [
      {
        name: "read_file",
        description: "Read",
        parameters: {},
        execute: async () => ({
          path: "a.py",
          version: 3,
          lines: "1: app = FastAPI()",
          totalLines: 1,
        }),
      },
      {
        name: "write_file",
        description: "Forbidden",
        parameters: {},
        execute: async () => {
          mutations++;
        },
      },
      {
        name: "explore_project",
        description: "Forbidden recursion",
        parameters: {},
        execute: async () => {
          mutations++;
        },
      },
    ],
    fetchImpl: (async (_u, init) => {
      const body = JSON.parse(String(init?.body));
      calls++;
      if (calls === 1) {
        assert.deepEqual(
          body.tools.map(
            (t: { function: { name: string } }) => t.function.name,
          ),
          ["read_file"],
        );
        assert.match(body.messages[1].content, /Find entrypoint/);
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "r1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"a.py"}',
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "answer",
                summary:
                  "a.py:1 creates the application. Callers remain unchecked.",
                edits: [],
              }),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  const result = (await tool.execute(
    { question: "Find entrypoint and callers" },
    base.signal,
  )) as { findings: string; evidence: { path: string }[] };
  assert.match(result.findings, /a.py:1/);
  assert.equal(result.evidence[0].path, "a.py");
  assert.equal(mutations, 0);
});
test("research can continue beyond the old seven-round/twelve-call limit", async () => {
  let calls = 0,
    executions = 0;
  const result = await requestBackend({
    ...base,
    history: [{ role: "user", text: "Inspect twenty independent files" }],
    timeoutMs: 0,
    tools: [
      {
        name: "read_file",
        description: "Read",
        parameters: {},
        execute: async () => {
          executions++;
          return { verified: true };
        },
      },
    ],
    fetchImpl: (async () => {
      calls++;
      return Response.json({
        choices: [
          {
            message:
              calls <= 20
                ? {
                    tool_calls: [
                      {
                        id: `r${calls}`,
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: JSON.stringify({
                            path: `file-${calls}.py`,
                          }),
                        },
                      },
                    ],
                  }
                : {
                    content: JSON.stringify({
                      status: "answer",
                      summary:
                        "Twenty files inspected; broader project coverage remains unchecked.",
                      edits: [],
                    }),
                  },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(executions, 20);
  assert.equal(result.status, "answer");
});

test("explicit local-only language forbids web without disabling ordinary documentation questions", () => {
  for (const text of [
    "No web search",
    "Without internet",
    "Do not edit files or search the web.",
    "Don't browse.",
    "Local-only exploration",
  ])
    assert.equal(webResearchForbidden(text), true);
  for (const text of [
    "Find the current web API docs",
    "Do not forget to search the web",
    "What does this function do?",
    "No web server is needed; look up the current native APIs.",
    "Do not edit the web server.",
  ])
    assert.equal(webResearchForbidden(text), false);
});
