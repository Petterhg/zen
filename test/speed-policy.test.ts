import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ResearchBriefs,
  parseResearchSummary,
} from "../extension/src/research-briefs.js";
import { configurationRequiresCancellation } from "../extension/src/settings-policy.js";
import { explorationTool } from "../extension/src/exploration.js";
const signal = () => new AbortController().signal;
test("slider and visual changes preserve backend work, while privacy/foreground effort changes cancel it", () => {
  for (const name of [
    "assistanceLevel",
    "followPair",
    "traceEnabled",
    "inlineSuggestions",
    "subagents",
  ])
    assert.equal(
      configurationRequiresCancellation(
        (field) => field === `pairCode.${name}`,
      ),
      false,
    );
  for (const name of ["shareEditorContext", "reasoningEffort"])
    assert.equal(
      configurationRequiresCancellation(
        (field) => field === `pairCode.${name}`,
      ),
      true,
    );
  assert.equal(
    configurationRequiresCancellation((field) =>
      ["pairCode.assistanceLevel", "pairCode.shareEditorContext"].includes(
        field,
      ),
    ),
    true,
  );
});
test("research briefs retain bounded findings and versions, invalidate on edits, and exclude raw tool bodies", () => {
  const cache = new ResearchBriefs();
  for (let i = 0; i < 10; i++)
    cache.remember("Inspect service " + i, "services/" + i, {
      status: "completed",
      findings: "Finding ".repeat(500),
      evidence: Array.from({ length: 50 }, () => ({
        path: "services/" + i + "/main.py",
        version: 7,
        startLine: 1,
        endLine: 30,
        lines: "PRIVATE_RAW_BODY",
        matches: [{ text: "PRIVATE_RAW_BODY" }],
      })),
      coverage: "Incomplete graph",
    });
  const snapshot = cache.snapshot();
  assert.ok(snapshot.briefs.length > 0 && snapshot.briefs.length <= 4);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 17000);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_RAW_BODY/);
  assert.equal(snapshot.briefs[0].evidence[0].version, 7);
  assert.equal(snapshot.briefs[0].stale, false);
  cache.invalidate();
  assert.ok(cache.snapshot().briefs.every((b) => b.stale));
  snapshot.briefs[0].findings = "mutated";
  assert.notEqual(cache.snapshot().briefs[0].findings, "mutated");
  cache.clear();
  assert.equal(cache.snapshot().briefs.length, 0);
});
test("saved research survives a session, routes by current file and invalidates only related sources", async () => {
  const data = new Map<string, unknown>();
  const store = {
    get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    update(key: string, value: unknown) {
      data.set(key, value);
      return Promise.resolve();
    },
  };
  const cache = new ResearchBriefs(store);
  const gatewayHash = "a".repeat(64),
    workerHash = "b".repeat(64);
  const verify = async (file: string) =>
    file.includes("gateway") ? gatewayHash : workerHash;
  await cache.rememberVerified(
    "gateway retries with UNSAVED_PROMPT",
    "services/gateway",
    {
      status: "completed",
      findings: "Retry entrypoint is here and UNSAVED_ANSWER",
      evidence: [
        {
          tool: "read_file",
          path: "services/gateway/retry.ts",
          startLine: 8,
          endLine: 12,
          hash: gatewayHash,
          version: 1,
          lines: "SECRET_SOURCE",
        },
      ],
      serviceBriefs: [
        {
          name: "gateway",
          scope: "services/gateway",
          entrypoints: [
            { text: "retry", path: "services/gateway/retry.ts", line: 8 },
          ],
          interfaces: [],
          dependencies: [],
          tests: [],
          unknowns: [],
        },
      ],
      coverage: "Callers not exhausted",
    },
    '["/repo-a"]',
    verify,
    signal(),
  );
  await cache.rememberVerified(
    "worker queue",
    "services/worker",
    {
      status: "completed",
      findings: "Worker entrypoint is here",
      evidence: [
        {
          tool: "read_file",
          path: "services/worker/queue.ts",
          startLine: 9,
          endLine: 12,
          hash: workerHash,
          version: 1,
        },
      ],
      serviceBriefs: [
        {
          name: "worker",
          scope: "services/worker",
          entrypoints: [
            { text: "queue", path: "services/worker/queue.ts", line: 9 },
          ],
          interfaces: [],
          dependencies: [],
          tests: [],
          unknowns: [],
        },
      ],
      coverage: "Tests checked",
    },
    '["/repo-a"]',
    verify,
    signal(),
  );
  cache.remember(
    "unsaved gateway idea",
    "services/gateway",
    {
      status: "completed",
      findings: "Tentative buffer behavior",
      evidence: [
        {
          tool: "read_file",
          path: "services/gateway/draft.ts",
          unsaved: true,
          version: 3,
        },
      ],
    },
    '["/repo-a"]',
  );
  cache.remember(
    "quoted unsaved context",
    "services/gateway",
    {
      status: "completed",
      findings: "A finding influenced by an unsaved buffer",
      containsUnsaved: true,
      evidence: [
        {
          tool: "read_file",
          path: "services/gateway/retry.ts",
          startLine: 8,
          version: 1,
        },
      ],
      serviceBriefs: [
        {
          name: "gateway",
          scope: "services/gateway",
          purpose: {
            text: "retry",
            path: "services/gateway/retry.ts",
            line: 8,
          },
        },
      ],
    },
    '["/repo-a"]',
  );
  await cache.flushed();
  assert.doesNotMatch(
    JSON.stringify([...data.values()]),
    /SECRET_SOURCE|Tentative buffer behavior|UNSAVED_PROMPT|UNSAVED_ANSWER|influenced by an unsaved/,
  );
  cache.beginSession();
  assert.equal(cache.snapshot("", "", '["/repo-a"]').briefs.length, 2);
  assert.equal(cache.snapshot("", "", '["/repo-b"]').briefs.length, 0);
  cache.invalidate("/repo/services/gateway/retry.ts");
  const byQuestion = cache.snapshot(
    "gateway retries",
    "",
    '["/repo-a"]',
  ).briefs;
  assert.equal(byQuestion[0].services[0].name, "gateway");
  assert.equal(byQuestion[0].stale, true);
  assert.equal(
    byQuestion.find((b) => b.services[0]?.name === "worker")?.stale,
    false,
  );
  await cache.flushed();
  const next = new ResearchBriefs(store);
  assert.equal(
    next.snapshot("gateway retries", "", '["/repo-a"]').briefs.length,
    2,
  );
  assert.ok(next.snapshot("", "", '["/repo-a"]').briefs.every((b) => b.stale));
  const changed = await next.verifiedSnapshot(
    "gateway",
    "",
    '["/repo-a"]',
    async () => "c".repeat(64),
    signal(),
  );
  assert.equal(changed.briefs[0].services.length, 0);
  assert.equal(changed.briefs[0].stale, true);
  const excluded = await next.verifiedSnapshot(
    "gateway",
    "",
    '["/repo-a"]',
    async () => {
      throw new Error("Ignored by current policy");
    },
    signal(),
  );
  assert.equal(excluded.briefs.length, 0);
  const added = new ResearchBriefs();
  added.remember(
    "new source discovery",
    "services/worker",
    {
      status: "completed",
      findings: "Existing queue",
      evidence: [
        {
          tool: "read_file",
          path: "services/worker/queue.ts",
          startLine: 1,
          endLine: 3,
        },
      ],
    },
    '["/repo-a"]',
  );
  added.invalidate("/repo-a/services/worker/new-handler.ts");
  assert.equal(added.snapshot().briefs[0].stale, true);
  const whole = new ResearchBriefs();
  whole.remember(
    "root map",
    ".",
    {
      status: "completed",
      findings: "Root map",
      evidence: [
        { tool: "read_file", path: "main.ts", startLine: 1, endLine: 2 },
      ],
    },
    '["/repo-a"]',
  );
  whole.invalidate("/repo-a/new-service/main.ts");
  assert.equal(whole.snapshot().briefs[0].stale, true);
  const lookup = next.tool(
    () => '["/repo-a"]',
    () => true,
    verify,
  );
  const retrieved = (await lookup.execute({ query: "gateway" }, signal())) as {
    briefs: { services: { name: string }[] }[];
  };
  assert.equal(retrieved.briefs[0].services.length, 0); // Explicit service invalidation is not cleared by unchanged seed hashes.
  assert.equal(
    (
      (await next
        .tool(
          () => '["/repo-b"]',
          () => true,
          verify,
        )
        .execute({ query: "gateway" }, signal())) as { briefs: unknown[] }
    ).briefs.length,
    0,
  );
  await assert.rejects(
    next
      .tool(
        () => '["/repo-a"]',
        () => false,
        verify,
      )
      .execute({ query: "gateway" }, signal()),
    /disabled/,
  );
});
test("structured service claims require an inspected source line", () => {
  const noBounds = parseResearchSummary(
    JSON.stringify({
      answer: "A",
      services: [
        {
          name: "gateway",
          scope: "services/gateway",
          purpose: {
            text: "Retry",
            path: "services/gateway/retry.ts",
            line: 8,
          },
        },
      ],
    }),
    [{ tool: "read_file", path: "services/gateway/retry.ts" }],
  );
  assert.equal(noBounds.services.length, 0);
  const result = parseResearchSummary(
    JSON.stringify({
      answer: "Task answer",
      services: [
        {
          name: "gateway",
          scope: "services/gateway",
          purpose: {
            text: "Retries requests",
            path: "services/gateway/retry.ts",
            line: 8,
          },
          dependencies: [
            {
              text: "Calls billing",
              path: "services/billing/main.ts",
              line: 2,
            },
          ],
          entrypoints: [],
          interfaces: [],
          tests: [],
          unknowns: ["Other callers not checked"],
        },
      ],
    }),
    [
      {
        tool: "read_file",
        path: "services/gateway/retry.ts",
        startLine: 5,
        endLine: 12,
        version: 3,
      },
    ],
  );
  assert.equal(result.answer, "Task answer");
  assert.equal(result.services[0].purpose?.version, 3);
  assert.equal(result.services[0].dependencies.length, 0);
});
test("brief lookup rechecks each current path once and keeps unsaved research as locators only", async () => {
  const cache = new ResearchBriefs();
  for (const question of ["first", "second"])
    cache.remember(
      question,
      "service",
      {
        status: "completed",
        findings: "Unsaved fact",
        containsUnsaved: true,
        evidence: [
          {
            tool: "read_file",
            path: "service/main.py",
            startLine: 1,
            endLine: 2,
            unsaved: true,
          },
        ],
      },
      '["/repo"]',
    );
  let calls = 0;
  const result = await cache.verifiedSnapshot(
    "service",
    "",
    '["/repo"]',
    async () => {
      calls++;
      return "a".repeat(64);
    },
    signal(),
  );
  assert.equal(calls, 1);
  assert.equal(result.briefs.length, 2);
  assert.ok(
    result.briefs.every(
      (b) => b.stale && !b.findings && !b.services.length && !b.question,
    ),
  );
});
test("concurrent persistence never saves a brief before source verification", async () => {
  const data = new Map<string, unknown>();
  const cache = new ResearchBriefs({
    get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    update(key: string, value: unknown) {
      data.set(key, value);
      return Promise.resolve();
    },
  });
  const hash = "f".repeat(64);
  let began!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = cache.rememberVerified(
    "service",
    "service",
    {
      status: "completed",
      findings: "Source-backed fact",
      evidence: [
        {
          tool: "read_file",
          path: "service/main.py",
          startLine: 1,
          endLine: 2,
          hash,
        },
      ],
      serviceBriefs: [
        {
          name: "service",
          scope: "service",
          purpose: { text: "Entry", path: "service/main.py", line: 1 },
        },
      ],
    },
    '["/repo"]',
    async () => {
      began();
      await waiting;
      return hash;
    },
    signal(),
  );
  await started;
  cache.remember(
    "another",
    "other",
    { status: "partial", findings: "No durable source" },
    '["/repo"]',
  );
  await cache.flushed();
  assert.deepEqual([...data.values()].flat(), []);
  release();
  await pending;
  await cache.flushed();
  assert.match(JSON.stringify([...data.values()]), /service\/main.py/);
});
test("explorer exposes batched reads, reuses compact research, and exports each inspected file version", async () => {
  let requests = 0;
  let received: Record<string, unknown> | undefined;
  const tool = explorationTool({
    provider: "cerebras",
    model: "test",
    apiKey: "fake",
    effort: "medium",
    researchReference: {
      briefs: [{ findings: "Prior service entrypoint is main.py" }],
    },
    onReport: (report) => {
      received = report;
    },
    tools: [
      {
        name: "read_files",
        description: "Read batch",
        parameters: {},
        execute: async () => ({
          files: [
            {
              path: "main.py",
              version: 3,
              startLine: 1,
              endLine: 2,
              lines: "RAW_SOURCE",
            },
            {
              path: "client.py",
              version: 4,
              startLine: 1,
              endLine: 2,
              lines: "RAW_SOURCE",
            },
          ],
        }),
      },
    ],
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests++;
      if (requests === 1) {
        assert.match(JSON.stringify(body.messages), /Prior service entrypoint/);
        assert.deepEqual(
          body.tools.map(
            (t: { function: { name: string } }) => t.function.name,
          ),
          ["read_files"],
        );
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "batch",
                    type: "function",
                    function: {
                      name: "read_files",
                      arguments:
                        '{"files":[{"path":"main.py"},{"path":"client.py"}]}',
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
                summary: JSON.stringify({
                  answer:
                    "main.py:1 calls client.py:2. Other callers unchecked.",
                  services: [
                    {
                      name: "demo",
                      scope: ".",
                      purpose: { text: "Entrypoint", path: "main.py", line: 1 },
                      entrypoints: [{ text: "Main", path: "main.py", line: 1 }],
                      interfaces: [],
                      dependencies: [
                        { text: "Client", path: "client.py", line: 2 },
                      ],
                      tests: [],
                      unknowns: ["Other callers unchecked"],
                    },
                  ],
                }),
                edits: [],
              }),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  const report = (await tool.execute(
    { question: "Inspect entrypoint and caller" },
    signal(),
  )) as {
    evidence: { path?: string; version?: number }[];
    findings: string;
    serviceBriefs: { purpose?: { path: string } }[];
  };
  assert.equal(received, report);
  assert.deepEqual(
    report.evidence.filter((e) => e.path).map((e) => [e.path, e.version]),
    [
      ["main.py", 3],
      ["client.py", 4],
    ],
  );
  assert.doesNotMatch(JSON.stringify(report), /RAW_SOURCE/);
  assert.match(report.findings, /Other callers unchecked/);
  assert.equal(report.serviceBriefs[0].purpose?.path, "main.py");
});
