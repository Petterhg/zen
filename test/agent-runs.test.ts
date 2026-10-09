import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuns, delegationTools } from "../extension/src/agent-runs.js";
import {
  researchAgents,
  agentRegistry,
  DEFAULT_AGENTS,
} from "../extension/src/subagents.js";
import { requestBackend } from "../extension/src/backend.js";
const tick = () => new Promise((r) => setImmediate(r));
const profile = {
  ...DEFAULT_AGENTS.explorer,
  name: "API critic",
  description: "Review API compatibility",
  orientation: false,
  mode: "background" as const,
};

test("registry migrates old preferences, supports arbitrary definitions and durable deletion", () => {
  const migrated = researchAgents({
    explorer: { instructions: "My conventions", enabled: false },
  });
  assert.equal(migrated.explorer.instructions, "My conventions");
  assert.equal(migrated.explorer.enabled, false);
  const custom = researchAgents(agentRegistry({ api_critic: profile }));
  assert.deepEqual(Object.keys(custom), ["api_critic"]);
  assert.deepEqual(researchAgents(agentRegistry({})), {});
  for (const bad of [
    { api: { ...profile, name: "" } },
    { api: { ...profile, mode: "other" } },
    { constructor: profile },
  ])
    assert.throws(() => researchAgents({ version: 2, agents: bad }));
});

test("parallel foreground cancellation leaves background running; completions delivered once", async () => {
  const completed: string[] = [];
  const runs = new AgentRuns(
    () => {},
    (r) => completed.push(r.id),
  );
  const parent = new AbortController();
  let finish!: (s: string) => void;
  const foreground = runs.launch(
    "api",
    profile,
    "foreground",
    "foreground",
    undefined,
    parent.signal,
    (s) =>
      new Promise((_r, reject) =>
        s.addEventListener("abort", () => reject(s.reason), { once: true }),
      ),
  );
  const background = runs.launch(
    "api",
    profile,
    "background",
    "background",
    undefined,
    parent.signal,
    async () => new Promise((r) => (finish = r)),
  );
  assert.equal(runs.snapshot().filter((r) => r.state === "running").length, 2);
  parent.abort();
  assert.equal((await foreground.done).state, "cancelled");
  assert.equal(
    runs.snapshot().find((r) => r.id === background.id)!.state,
    "running",
  );
  finish("Verified result");
  await background.done;
  await tick();
  assert.deepEqual(completed, [background.id]);
  assert.equal(runs.drain().length, 1);
  assert.deepEqual(runs.drain(), []);
});

test("four-run concurrency, queued stop and session clearing discard late results", async () => {
  let calls = 0;
  const finish: (() => void)[] = [];
  const runs = new AgentRuns(
    () => {},
    () => {
      calls++;
    },
  );
  const signal = new AbortController().signal;
  const all = Array.from({ length: 6 }, () =>
    runs.launch(
      "api",
      profile,
      "task",
      "background",
      undefined,
      signal,
      () => new Promise((r) => finish.push(() => r("old result"))),
    ),
  );
  assert.equal(finish.length, 4);
  runs.stop(all[4].id);
  assert.equal((await all[4].done).state, "cancelled");
  runs.clear();
  for (const f of finish) f();
  await Promise.all(all.map((r) => r.done));
  await tick();
  assert.equal(calls, 0);
  assert.deepEqual(runs.snapshot(), []);
  assert.deepEqual(runs.drain(), []);
});

test("generic workers receive only delegated context and safe tools, retain settings snapshot and expose real activity", async () => {
  const runs = new AgentRuns();
  const parent = new AbortController();
  let agents = { critic: profile },
    requests = 0;
  const calls: Record<string, unknown>[] = [];
  const tools = delegationTools(runs, {
    agents: () => agents,
    key: async () => "RESEARCH_KEY",
    provider: "cerebras",
    model: "parent",
    apiKey: "PARENT_KEY",
    allowWeb: false,
    taskState: { secretHistory: "PARENT_CONTEXT" },
    tools: ["read_file", "write_file", "delegate_to_agents", "web_search"].map(
      (name) => ({
        name,
        description: name,
        parameters: {},
        execute: async () => ({
          path: "api.ts",
          lines: "export function api() {}",
          reasoning: "NOT_VISIBLE",
        }),
      }),
    ),
    fetchImpl: (async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      assert.doesNotMatch(JSON.stringify(body), /PARENT_CONTEXT|PARENT_KEY/);
      assert.deepEqual(
        body.tools?.map(
          (t: { function: { name: string } }) => t.function.name,
        ) ?? [],
        requests === 1 ? ["read_file"] : ["read_file"],
      );
      if (requests === 1)
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                reasoning: "PRIVATE_THINKING",
                tool_calls: [
                  {
                    id: "read",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"api.ts"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                status: "answer",
                summary: "api.ts:1 exports api.",
                edits: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.match(tools[0].description, /API critic.*Review API compatibility/);
  const result = await tools[0].execute(
    {
      tasks: [
        { agent: "critic", task: "Inspect public API", mode: "foreground" },
      ],
    },
    parent.signal,
  );
  assert.match(JSON.stringify(result), /exports api/);
  assert.equal(runs.snapshot()[0].activity.length, 2);
  assert.doesNotMatch(
    JSON.stringify(runs.snapshot()),
    /NOT_VISIBLE|PRIVATE_THINKING/,
  );
  agents = { critic: { ...profile, enabled: false } };
  await assert.rejects(
    tools[0].execute(
      { tasks: [{ agent: "critic", task: "Again" }] },
      parent.signal,
    ),
    /disabled/,
  );
  assert.equal(runs.snapshot()[0].agent.enabled, true);
  assert.equal(calls.length, 2);
});

test("main loop consumes completion notices between calls without restarting the request", async () => {
  let call = 0,
    pending = false;
  await requestBackend({
    provider: "cerebras",
    model: "fixture",
    apiKey: "fixture",
    history: [{ role: "user", text: "Check API" }],
    signal: new AbortController().signal,
    notifications: () =>
      pending
        ? ((pending = false), [{ id: "run-1", output: "Worker finished" }])
        : [],
    tools: [
      {
        name: "read_file",
        description: "read",
        parameters: {},
        execute: async () => {
          pending = true;
          return { path: "api.ts", lines: "x" };
        },
      },
    ],
    fetchImpl: (async (_url, init) => {
      call++;
      const body = JSON.parse(String(init?.body));
      if (call === 1)
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "r",
                    type: "function",
                    function: { name: "read_file", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      assert.match(JSON.stringify(body.messages), /Worker finished/);
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                status: "answer",
                summary: "Verified",
                edits: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(call, 2);
});

test("parent receipts and run lists stay compact while full inspector output remains available", async () => {
  const runs = new AgentRuns();
  const report = "evidence ".repeat(1300);
  const job = runs.launch(
    "api",
    profile,
    "Inspect",
    "background",
    undefined,
    new AbortController().signal,
    async (_signal, log) => {
      log("read_file", { path: "api.ts" }, { source: "SOURCE_BODY" });
      return report;
    },
  );
  await job.done;
  const receipt = runs.drain()[0];
  assert.equal(receipt.output!.length, 2000);
  assert.equal(receipt.truncated, true);
  assert.equal(runs.result(job.id).output, report);
  assert.doesNotMatch(
    JSON.stringify(runs.list()),
    /SOURCE_BODY|User-defined specialization/,
  );
  assert.match(JSON.stringify(runs.detail(job.id)), /SOURCE_BODY/);
});
