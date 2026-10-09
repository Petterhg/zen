import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestBackend, DEFAULT_MODELS } from "../extension/src/backend.js";
import { TraceJournal, type TraceEvent } from "../extension/src/trace.js";
const answer = {
  status: "clarification",
  summary:
    "Start with an app instance and one health endpoint. Do you want me to propose that in the empty file?",
  speech: "Start with a tiny app and one health endpoint.",
  edits: [],
};
test("a complete structured answer with tools available avoids a redundant model call", async () => {
  let requests = 0;
  const events: TraceEvent[] = [];
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [{ role: "user", text: "What does this file do?" }],
    effort: "none",
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => {
          throw Error("Unexpected lookup");
        },
      },
    ],
    signal: new AbortController().signal,
    onTrace: (e) => events.push(e),
    fetchImpl: (async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.reasoning_effort, "none");
      return Response.json({
        choices: [{ message: { content: JSON.stringify(answer) } }],
      });
    }) as typeof fetch,
  });
  assert.equal(requests, 1);
  assert.equal(result.summary, answer.summary);
  assert.ok(events.some((e) => e.type === "backend.direct_result"));
});
test("a focused source question uses one read-only structured call, with no tools executed", async () => {
  let calls = 0;
  const events: TraceEvent[] = [];
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [{ role: "user", text: "Explain this file." }],
    responseStyle: "brief",
    assistanceLevel: 75,
    signal: new AbortController().signal,
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => {
          throw Error("Should use captured source");
        },
      },
    ],
    onTrace: (e) => events.push(e),
    fetchImpl: (async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools, undefined);
      assert.equal(body.reasoning_effort, "none");
      assert.equal(
        body.response_format.json_schema.schema.properties.edits.maxItems,
        0,
      );
      assert.ok(
        body.response_format.json_schema.schema.properties.status.enum.includes(
          "needs_context",
        ),
      );
      assert.match(body.messages[0].content, /READ-ONLY CONTEXT ANSWER/);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(answer) } }],
      });
    }) as typeof fetch,
  });
  assert.equal(calls, 1);
  assert.equal(result.summary, answer.summary);
  assert.ok(events.some((e) => e.type === "backend.context_answer"));
});
test("missing source and invalid read-only previews escalate to the full tool path without executing edits", async () => {
  for (const initial of [
    {
      status: "needs_context",
      summary: "Read the imported handler.",
      edits: [],
    },
    {
      status: "proposal",
      summary: "Forbidden first-pass edit",
      edits: [{ oldText: "", newText: "unsafe" }],
    },
    "broken JSON",
  ]) {
    let calls = 0,
      reads = 0;
    const events: TraceEvent[] = [];
    const result = await requestBackend({
      provider: "cerebras",
      model: DEFAULT_MODELS.cerebras,
      apiKey: "fake",
      history: [{ role: "user", text: "What does handler do?" }],
      responseStyle: "brief",
      signal: new AbortController().signal,
      tools: [
        {
          name: "read_file",
          description: "read",
          parameters: {},
          execute: async () => {
            reads++;
            return { lines: "1: def handler(): pass" };
          },
        },
      ],
      onTrace: (e) => events.push(e),
      fetchImpl: (async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        if (calls === 2)
          assert.ok(
            body.tools.some(
              (t: { function: { name: string } }) =>
                t.function.name === "read_file",
            ),
          );
        return Response.json({
          choices: [
            {
              message:
                calls === 1
                  ? {
                      content:
                        typeof initial === "string"
                          ? initial
                          : JSON.stringify(initial),
                    }
                  : calls === 2
                    ? {
                        tool_calls: [
                          {
                            id: "read",
                            type: "function",
                            function: { name: "read_file", arguments: "{}" },
                          },
                        ],
                      }
                    : { content: JSON.stringify(answer) },
            },
          ],
        });
      }) as typeof fetch,
    });
    assert.equal(result.edits.length, 0);
    assert.equal(calls, 3);
    assert.equal(reads, 1);
    assert.ok(
      events.some(
        (e) =>
          e.type === "backend.context_gap" ||
          e.type === "backend.context_fallback",
      ),
    );
  }
});
test("an empty first-pass summary gets one read-only repair without unnecessary research", async () => {
  let calls = 0;
  const events: TraceEvent[] = [];
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [{ role: "user", text: "Can you explain this file?" }],
    responseStyle: "brief",
    signal: new AbortController().signal,
    onTrace: (e) => events.push(e),
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => {
          throw Error("Unneeded research");
        },
      },
    ],
    fetchImpl: (async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools, undefined);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify(
                calls === 1
                  ? { status: "answer", summary: "", edits: [] }
                  : answer,
              ),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(result.summary, answer.summary);
  assert.equal(calls, 2);
  assert.ok(events.some((e) => e.type === "backend.context_repair"));
});
test("a canceled first-pass response is never delivered", async () => {
  const controller = new AbortController();
  await assert.rejects(
    requestBackend({
      provider: "cerebras",
      model: DEFAULT_MODELS.cerebras,
      apiKey: "fake",
      history: [{ role: "user", text: "Explain this file." }],
      responseStyle: "brief",
      signal: controller.signal,
      fetchImpl: (async () => {
        controller.abort();
        return Response.json({
          choices: [{ message: { content: JSON.stringify(answer) } }],
        });
      }) as typeof fetch,
    }),
    /abort/i,
  );
});
test("a read-only context answer honors explicitly configured reasoning effort", async () => {
  for (const effort of ["low", "medium", "high"] as const) {
    await requestBackend({
      provider: "cerebras",
      model: DEFAULT_MODELS.cerebras,
      apiKey: "fake",
      history: [{ role: "user", text: "Explain this file." }],
      responseStyle: "brief",
      effort,
      signal: new AbortController().signal,
      fetchImpl: (async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).reasoning_effort, effort);
        return Response.json({
          choices: [{ message: { content: JSON.stringify(answer) } }],
        });
      }) as typeof fetch,
    });
  }
});
test("direct JSON results still repair forbidden edits instead of bypassing assistance", async () => {
  let calls = 0;
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [{ role: "user", text: "Explain this code" }],
    assistanceLevel: 0,
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => ({}),
      },
    ],
    signal: new AbortController().signal,
    fetchImpl: (async () => {
      calls++;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify(
                calls === 1
                  ? {
                      status: "proposal",
                      summary: "Unsafe preview",
                      edits: [{ oldText: "", newText: "print(1)" }],
                    }
                  : answer,
              ),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(calls, 2);
  assert.equal(result.edits.length, 0);
});
test("plain prose after tools is finalized separately with a schema rather than parsed as JSON", async () => {
  const requests: Record<string, unknown>[] = [];
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [{ role: "user", text: "How should I start with FastAPI?" }],
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => "",
      },
    ],
    signal: new AbortController().signal,
    fetchImpl: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content:
                requests.length === 1
                  ? "Just to be sure, start with an app instance."
                  : JSON.stringify(answer),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(result.status, "clarification");
  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools);
  assert.equal(requests[0].response_format, undefined);
  assert.equal(requests[1].tools, undefined);
  assert.equal(requests[1].reasoning_effort, "none");
  assert.equal(
    (requests[1].response_format as { json_schema: { strict: boolean } })
      .json_schema.strict,
    true,
  );
});
test("truncated tool calls are not executed; bounded recovery accounts for reasoning usage", async () => {
  const requests: Record<string, unknown>[] = [];
  const events: TraceEvent[] = [];
  let executions = 0;
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [{ role: "user", text: "Inspect this project." }],
    signal: new AbortController().signal,
    onTrace: (event) => events.push(event),
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => {
          executions++;
          return { lines: "1: source" };
        },
      },
    ],
    fetchImpl: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const n = requests.length;
      return Response.json({
        usage: {
          completion_tokens: n === 1 ? 4096 : 50,
          completion_tokens_details: { reasoning_tokens: n === 1 ? 4090 : 0 },
        },
        choices: [
          {
            finish_reason: n === 1 ? "length" : n === 2 ? "tool_calls" : "stop",
            message:
              n <= 2
                ? {
                    reasoning: "SECRET_REASONING",
                    tool_calls: [
                      {
                        id: n === 1 ? "partial" : "valid",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: n === 1 ? "{" : "{}",
                        },
                      },
                    ],
                  }
                : {
                    content:
                      n === 3
                        ? "I found the app entry."
                        : JSON.stringify(answer),
                  },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(result.status, "clarification");
  assert.equal(executions, 1);
  assert.equal(requests[1].max_tokens, 32768);
  assert.equal(requests[1].reasoning_effort, "none");
  assert.equal(requests.length, 4);
  assert.ok(events.some((e) => e.type === "provider.recovery"));
  assert.ok(JSON.stringify(events).includes("reasoning_tokens"));
  assert.ok(!JSON.stringify(events).includes("SECRET_REASONING"));
  assert.ok(
    !JSON.stringify(requests.slice(1)).includes('"tool_call_id":"partial"'),
  );
});
test("persistent output exhaustion returns a truthful no-preview result after internal recovery", async () => {
  let calls = 0;
  const result = await requestBackend({
    provider: "together",
    model: DEFAULT_MODELS.together,
    apiKey: "fake",
    history: [],
    signal: new AbortController().signal,
    fetchImpl: (async () => {
      calls++;
      return Response.json({
        choices: [{ finish_reason: "length", message: { content: "partial" } }],
      });
    }) as typeof fetch,
  });
  assert.equal(result.edits.length, 0);
  assert.match(result.summary, /No preview is ready/);
  assert.equal(calls, 2);
});
test("invalid structured output gives a stable error without exposing partial model text", async () => {
  await assert.rejects(
    requestBackend({
      provider: "cerebras",
      model: DEFAULT_MODELS.cerebras,
      apiKey: "fake",
      history: [],
      signal: new AbortController().signal,
      fetchImpl: (async () =>
        Response.json({
          choices: [{ message: { content: "Just to be SECRET_TEXT" } }],
        })) as typeof fetch,
    }),
    (error) =>
      (error as { code?: string }).code === "invalid_response" &&
      !String(error).includes("SECRET_TEXT"),
  );
});
test("local traces retain conversation and usage but redact keys/reasoning and obey disabling", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "pair-trace-"));
  let enabled = true;
  try {
    const journal = new TraceJournal(folder, () => enabled);
    journal.record({
      type: "conversation",
      text: "hello",
      apiKey: "secret",
      reasoning: "private",
      nested: {
        authorization: "Bearer token",
        usage: { completion_tokens_details: { reasoning_tokens: 3 } },
      },
      message: "Bearer abcdefgh sk-12345678901234567890",
    });
    enabled = false;
    journal.record({ type: "should-not-appear" });
    await journal.flush();
    const data = await readFile(journal.file, "utf8");
    assert.ok(data.includes("hello"));
    assert.ok(data.includes("reasoning_tokens"));
    for (const forbidden of [
      "secret",
      "private",
      "abcdefgh",
      "12345678901234567890",
      "should-not-appear",
    ])
      assert.ok(!data.includes(forbidden));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a mismatched replacement gets one repair and still requires an exact buffer anchor", async () => {
  const context = {
    uri: "file:///demo/a.py",
    file: "a.py",
    version: 1,
    language: "python",
    text: "def hello():\n    return 1\n",
    selection: "",
    selectionStart: 0,
    selectionEnd: 0,
    diagnostics: [],
  };
  for (const repairWorks of [true, false]) {
    const traces: TraceEvent[] = [];
    let requests = 0;
    const run = requestBackend({
      provider: "cerebras",
      model: DEFAULT_MODELS.cerebras,
      apiKey: "fake",
      context,
      history: [{ role: "user", text: "Return 2 instead." }],
      signal: new AbortController().signal,
      onTrace: (e) => traces.push(e),
      fetchImpl: (async () => {
        requests++;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "proposal",
                  summary: "Change return value",
                  speech: "Preview ready",
                  edits: [
                    {
                      oldText:
                        requests === 2 && repairWorks
                          ? "return 1"
                          : "7: return 1",
                      newText: "return 2",
                    },
                  ],
                }),
              },
            },
          ],
        });
      }) as typeof fetch,
    });
    if (repairWorks) assert.equal((await run).edits[0].oldText, "return 1");
    else assert.equal((await run).edits.length, 0);
    assert.equal(requests, repairWorks ? 2 : 3);
    assert.ok(traces.some((e) => e.type === "backend.repair"));
  }
});
test("identical tool calls are cached and a stalled loop proceeds to structured finalization", async () => {
  let executions = 0;
  let requests = 0;
  const traces: TraceEvent[] = [];
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [],
    signal: new AbortController().signal,
    onTrace: (e) => traces.push(e),
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => {
          executions++;
          return { lines: "1: hi" };
        },
      },
    ],
    fetchImpl: (async (_u, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      return Response.json({
        choices: [
          {
            message: body.tools
              ? {
                  tool_calls: [
                    {
                      id: String(requests),
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: '{"path":"a.py"}',
                      },
                    },
                  ],
                }
              : { content: JSON.stringify(answer) },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(result.status, "clarification");
  assert.equal(executions, 1);
  assert.equal(requests, 4);
  assert.equal(traces.filter((e) => e.type === "tool.cached").length, 2);
});

test("malformed structured output is repaired with the inspected evidence still present", async () => {
  const requests: Record<string, unknown>[] = [];
  const traces: TraceEvent[] = [];
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [{ role: "user", text: "Explain the checked flow." }],
    conversationMode: "chat",
    assistanceLevel: 0,
    signal: new AbortController().signal,
    onTrace: (e) => traces.push(e),
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => ({ lines: "12: reject before runtime" }),
      },
    ],
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const n = requests.length;
      return Response.json({
        choices: [
          {
            message:
              n === 1
                ? {
                    tool_calls: [
                      {
                        id: "read",
                        type: "function",
                        function: { name: "read_file", arguments: "{}" },
                      },
                    ],
                  }
                : {
                    content:
                      n === 2
                        ? "The source rejects before runtime."
                        : n === 3
                          ? "{bad JSON"
                          : JSON.stringify({
                              status: "answer",
                              summary: "src/chat.py:12 rejects before runtime.",
                              edits: [],
                            }),
                  },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(result.summary, "src/chat.py:12 rejects before runtime.");
  assert.equal(requests.length, 4);
  assert.ok(
    JSON.stringify(requests[3].messages).includes("12: reject before runtime"),
  );
  assert.match(
    JSON.stringify(requests[3].messages),
    /Application schema feedback/,
  );
  assert.ok(
    traces.some(
      (e) => e.type === "backend.repair" && e.reason === "structured_output",
    ),
  );
});

test("research synthesis can preserve a structured service brief beyond the chat answer limit", async () => {
  const summary = JSON.stringify({
    answer: "a".repeat(3500),
    services: [{ scope: "services/demo", purpose: "b".repeat(2000) }],
  });
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    instructions:
      "Research only. summary contains JSON-encoded answer and services.",
    history: [],
    signal: new AbortController().signal,
    fetchImpl: (async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ status: "answer", summary, edits: [] }),
            },
          },
        ],
      })) as typeof fetch,
  });
  assert.equal(result.summary, summary);
  assert.ok(result.summary.length > 4000);
});

test("oversized chat answers receive feedback rather than silent truncation", async () => {
  let calls = 0;
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    conversationMode: "chat",
    history: [],
    signal: new AbortController().signal,
    fetchImpl: (async (_url, init) => {
      calls++;
      if (calls === 2)
        assert.match(String(init?.body), /up to 4000 characters/);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "answer",
                summary:
                  calls === 1 ? "x".repeat(4001) : "Complete smaller answer.",
                edits: [],
              }),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(calls, 2);
  assert.equal(result.summary, "Complete smaller answer.");
});

test("an explicit no-web request removes public tools and cannot execute a hallucinated web call", async () => {
  let networkTools = 0;
  const requests: Record<string, unknown>[] = [];
  const result = await requestBackend({
    provider: "cerebras",
    model: DEFAULT_MODELS.cerebras,
    apiKey: "fake",
    history: [
      {
        role: "user",
        text: "Inspect this service. Do not edit files or use web search.",
      },
    ],
    conversationMode: "chat",
    signal: new AbortController().signal,
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => ({ path: "a.py" }),
      },
      ...["web_search", "fetch_page"].map((name) => ({
        name,
        description: "public",
        parameters: {},
        execute: async () => {
          networkTools++;
          return {};
        },
      })),
    ],
    fetchImpl: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [
          {
            message:
              requests.length === 1
                ? {
                    tool_calls: [
                      {
                        id: "forbidden",
                        type: "function",
                        function: {
                          name: "web_search",
                          arguments: '{"query":"n/a"}',
                        },
                      },
                    ],
                  }
                : {
                    content: JSON.stringify({
                      status: "answer",
                      summary: "Local source only.",
                      edits: [],
                    }),
                  },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(result.status, "answer");
  assert.equal(networkTools, 0);
  assert.doesNotMatch(
    JSON.stringify(requests[0].tools),
    /web_search|fetch_page/,
  );
});
