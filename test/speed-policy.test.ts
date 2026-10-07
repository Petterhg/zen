import { test } from "node:test";
import assert from "node:assert/strict";
import { ResearchBriefs } from "../extension/src/research-briefs.js";
import { configurationRequiresCancellation } from "../extension/src/settings-policy.js";
import { explorationTool } from "../extension/src/exploration.js";
const signal = () => new AbortController().signal;
test("slider and visual changes preserve backend work, while privacy/provider changes cancel it", () => {
  for (const name of [
    "assistanceLevel",
    "followPair",
    "traceEnabled",
    "inlineSuggestions",
  ])
    assert.equal(
      configurationRequiresCancellation(
        (field) => field === `pairCode.${name}`,
      ),
      false,
    );
  for (const name of [
    "shareEditorContext",
    "backend",
    "cerebrasModel",
    "reasoningEffort",
  ])
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
  assert.ok(snapshot.briefs.length > 0 && snapshot.briefs.length <= 3);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 13000);
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
    onReport: (report) => (received = report),
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
        assert.match(body.messages[1].content, /Prior service entrypoint/);
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
                summary:
                  "main.py:1 calls client.py:2. Other callers unchecked.",
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
  )) as { evidence: { path?: string; version?: number }[] };
  assert.equal(received, report);
  assert.deepEqual(
    report.evidence.filter((e) => e.path).map((e) => [e.path, e.version]),
    [
      ["main.py", 3],
      ["client.py", 4],
    ],
  );
  assert.doesNotMatch(JSON.stringify(report), /RAW_SOURCE/);
});
