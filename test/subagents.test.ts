import { test } from "node:test";
import assert from "node:assert/strict";
import {
  researchAgents,
  researchChoice,
  RESEARCH_MODELS,
} from "../extension/src/subagents.js";
import { explorationTool } from "../extension/src/exploration.js";
import { requestBackend } from "../extension/src/backend.js";
import type { TraceEvent } from "../extension/src/trace.js";

test("research profiles use Flash/Pro defaults, validate overrides and isolate copies", () => {
  const agents = researchAgents(undefined);
  assert.equal(agents.explorer.model, RESEARCH_MODELS[0]);
  assert.equal(agents.deep_research.model, RESEARCH_MODELS[1]);
  assert.equal(researchChoice(agents, "medium"), "explorer");
  assert.equal(researchChoice(agents, "high"), "deep_research");
  agents.explorer.instructions = "Changed";
  assert.notEqual(researchAgents(undefined).explorer.instructions, "Changed");
  assert.equal(
    researchChoice(
      researchAgents({ deep_research: { enabled: false } }),
      "high",
    ),
    "explorer",
  );
  assert.equal(
    researchChoice(researchAgents({ explorer: { enabled: false } }), "medium"),
    "deep_research",
  );
  for (const value of [
    null,
    [],
    { shell: {} },
    { explorer: { provider: "groq" } },
    { explorer: { model: "unapproved/model" } },
    { explorer: { enabled: "yes" } },
    { explorer: { reasoningEffort: "unlimited" } },
    { explorer: { instructions: "x".repeat(8001) } },
  ])
    assert.throws(() => researchAgents(value));
});

test("named research delegates to configured Together model without parent source/history, writes or recursive tools", async () => {
  for (const id of ["explorer", "deep_research"] as const) {
    const agents = researchAgents({
      [id]: { instructions: "SPECIALIZATION_TEST: inspect tests too." },
    });
    const traces: TraceEvent[] = [];
    let reads = 0,
      requests = 0;
    const tool = explorationTool({
      provider: "cerebras",
      model: "parent-model",
      apiKey: "PARENT_KEY",
      agents,
      researchKey: async () => "RESEARCH_KEY",
      effort: "medium",
      context: {
        uri: "file:///a.py",
        file: "a.py",
        language: "python",
        version: 1,
        text: "PARENT_FULL_BUFFER",
        selection: "",
        selectionStart: 0,
        selectionEnd: 0,
        diagnostics: [],
      },
      onTrace: (e) => traces.push(e),
      tools: [
        {
          name: "read_file",
          description: "Read source",
          parameters: {},
          execute: async () => {
            reads++;
            return {
              path: "a.py",
              startLine: 1,
              endLine: 1,
              lines: "CHILD_SOURCE_ONLY",
            };
          },
        },
        ...[
          "write_file",
          "run_shell",
          "explore_project",
          "code_focus",
          "remember_preference",
        ].map((name) => ({
          name,
          description: "Forbidden",
          parameters: {},
          execute: async () => {
            throw Error("Unauthorized tool ran");
          },
        })),
      ],
      fetchImpl: (async (url, init) => {
        requests++;
        assert.equal(url, "https://api.together.ai/v1/chat/completions");
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          "Bearer RESEARCH_KEY",
        );
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, agents[id].model);
        assert.equal(body.reasoning_effort, undefined);
        assert.deepEqual(body.reasoning, { enabled: true });
        assert.match(body.messages[0].content, /SPECIALIZATION_TEST/);
        assert.doesNotMatch(
          JSON.stringify(body.messages),
          /PARENT_FULL_BUFFER/,
        );
        if (requests === 1) {
          assert.deepEqual(
            body.tools.map(
              (t: { function: { name: string } }) => t.function.name,
            ),
            ["read_file"],
          );
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  reasoning: "CHILD_THINKING_ONLY",
                  tool_calls: [
                    {
                      id: "read",
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
        assert.match(JSON.stringify(body.messages), /CHILD_THINKING_ONLY/);
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "answer",
                  summary: "a.py:1 entrypoint. Other callers unchecked.",
                  edits: [],
                }),
              },
            },
          ],
        });
      }) as typeof fetch,
    });
    assert.match(tool.description, /complex architecture/);
    const report = (await tool.execute(
      { question: "Inspect this service", agent: id },
      new AbortController().signal,
    )) as Record<string, unknown>;
    assert.equal(report.agent, id);
    assert.equal(report.model, agents[id].model);
    assert.equal(reads, 1);
    assert.match(JSON.stringify(report), /a.py:1/);
    assert.doesNotMatch(
      JSON.stringify(report) + JSON.stringify(traces),
      /CHILD_THINKING_ONLY|CHILD_SOURCE_ONLY|PARENT_KEY|RESEARCH_KEY/,
    );
  }
});

test("disabled/unknown/missing-key research cannot start source inspection or provider calls", async () => {
  let executions = 0;
  const options = {
    provider: "cerebras" as const,
    model: "parent",
    apiKey: "fake",
    tools: [
      {
        name: "read_file",
        description: "Read",
        parameters: {},
        execute: async () => {
          executions++;
        },
      },
    ],
    fetchImpl: (async () => {
      executions++;
      throw Error("Unexpected provider call");
    }) as typeof fetch,
  };
  const signal = new AbortController().signal;
  const disabled = explorationTool({
    ...options,
    agents: researchAgents({ explorer: { enabled: false } }),
    researchKey: async () => "fake",
  });
  await assert.rejects(
    disabled.execute({ question: "Explore", agent: "explorer" }, signal),
    /disabled/,
  );
  await assert.rejects(
    disabled.execute({ question: "Explore", agent: "shell" }, signal),
    /Unknown/,
  );
  const noKey = explorationTool({
    ...options,
    agents: researchAgents(undefined),
    researchKey: async () => undefined,
  });
  await assert.rejects(
    noKey.execute({ question: "Explore" }, signal),
    /Together API key/,
  );
  assert.equal(executions, 0);
  const local = explorationTool({
    ...options,
    agents: researchAgents(undefined),
    allowWeb: false,
    researchKey: async () => "fake",
  });
  await assert.rejects(
    local.execute({ question: "Explore", include_web: true }, signal),
    /not requested/,
  );
  assert.equal(executions, 0);
});

test("Together reasoning off uses its API toggle and structured contract for all approved models", async () => {
  for (const model of RESEARCH_MODELS) {
    const traces: TraceEvent[] = [];
    const result = await requestBackend({
      provider: "together",
      model,
      apiKey: "fake",
      effort: "none",
      history: [{ role: "user", text: "Explain the inspected file" }],
      signal: new AbortController().signal,
      onTrace: (e) => traces.push(e),
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.reasoning, { enabled: false });
        assert.equal(body.reasoning_format, undefined);
        assert.equal(body.reasoning_effort, undefined);
        assert.equal(body.response_format.type, "json_schema");
        assert.equal(
          body.response_format.json_schema.schema.properties.edits.type,
          "array",
        );
        return Response.json({
          choices: [
            {
              message: {
                content:
                  '{"status":"answer","summary":"Verified result","edits":[]}',
                reasoning: "HIDDEN_THINKING",
              },
            },
          ],
        });
      }) as typeof fetch,
    });
    assert.equal(result.summary, "Verified result");
    assert.doesNotMatch(
      JSON.stringify(traces) + JSON.stringify(result),
      /HIDDEN_THINKING/,
    );
  }
});

test("cancelling a selected research profile suppresses its report", async () => {
  const controller = new AbortController();
  let reports = 0;
  const tool = explorationTool({
    provider: "cerebras",
    model: "parent",
    apiKey: "fake",
    agents: researchAgents(undefined),
    researchKey: async () => "fake",
    onReport: () => {
      reports++;
    },
    fetchImpl: (async () => {
      controller.abort();
      throw new Error("cancelled");
    }) as typeof fetch,
  });
  await assert.rejects(
    tool.execute(
      { question: "Investigate", agent: "deep_research" },
      controller.signal,
    ),
  );
  assert.equal(reports, 0);
});
