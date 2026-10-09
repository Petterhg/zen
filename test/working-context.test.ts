import { requestBackend } from "../extension/src/backend.js";
import { createProposal, type EditorContext } from "../extension/src/core.js";
import { discoveryExcluded } from "../extension/src/discovery.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  ContextWarmups,
  seedPaths,
  serviceScope,
  contextRelevant,
  explicitExploration,
  explorationScope,
  numberedEditorReference,
  compactResearchContext,
  hasFreshService,
  orientationSeed,
  focusedSymbolEvidence,
} from "../extension/src/working-context.js";
import {
  ResearchBriefs,
  parseResearchSummary,
} from "../extension/src/research-briefs.js";
import { explorationTool } from "../extension/src/exploration.js";
const signal = () => new AbortController().signal;
test("focused symbol questions route one unique local declaration with bounded numbered source", async () => {
  const context: EditorContext = {
    uri: "file:///demo/services/gateway/main.py",
    file: "services/gateway/main.py",
    version: 3,
    language: "python",
    text: "from .auth import authenticate\n",
    selection: "",
    selectionStart: 0,
    selectionEnd: 0,
    diagnostics: [],
  };
  let searches = 0,
    reads = 0;
  let matches = [
    {
      path: "services/gateway/auth.py",
      line: 15,
      text: "async def authenticate(request):",
    },
  ];
  let complete = true;
  const tools = [
    {
      name: "search_text",
      description: "scoped",
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        searches++;
        assert.deepEqual(args, {
          query: "authenticate",
          scope: "services/gateway",
        });
        return { matches, complete };
      },
    },
    {
      name: "read_files",
      description: "read",
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        reads++;
        assert.deepEqual(args, {
          files: [
            { path: "services/gateway/auth.py", start_line: 7, end_line: 86 },
          ],
        });
        return {
          files: [
            {
              path: "services/gateway/auth.py",
              hash: "a".repeat(64),
              version: 4,
              unsaved: true,
              lines: "15: async def authenticate(request):",
              startLine: 7,
              endLine: 40,
            },
          ],
        };
      },
    },
  ];
  const source = (await focusedSymbolEvidence(
    "authenticate",
    context,
    tools,
    signal(),
  )) as { unsaved: boolean; version: number; lines: string; coverage: string };
  assert.equal(source.unsaved, true);
  assert.equal(source.version, 4);
  assert.match(source.lines, /15: async def authenticate/);
  assert.match(source.coverage, /Not a complete call graph/);
  assert.equal(reads, 1);
  complete = false;
  assert.equal(
    await focusedSymbolEvidence("authenticate", context, tools, signal()),
    undefined,
  );
  complete = true;
  matches = [
    ...matches,
    {
      path: "services/gateway/other.py",
      line: 21,
      text: "def authenticate():",
    },
  ];
  assert.equal(
    await focusedSymbolEvidence("authenticate", context, tools, signal()),
    undefined,
  );
  assert.equal(reads, 1);
  const before = searches;
  assert.equal(
    await focusedSymbolEvidence(
      "authenticate",
      { ...context, text: "def authenticate():\n    return 1" },
      tools,
      signal(),
    ),
    undefined,
  );
  assert.equal(searches, before);
});
test("orientation routes within the active service and prioritizes source over inventories", () => {
  assert.equal(
    serviceScope("mono/services/gateway/src/retry.ts"),
    "mono/services/gateway",
  );
  assert.equal(serviceScope("packages/editor/src/foo.ts"), "packages/editor");
  assert.equal(serviceScope("src/main.py"), ".");
  const seeds = seedPaths(
    [
      "README.md",
      "pyproject.toml",
      "src/main.py",
      ...Array.from({ length: 500 }, (_, i) => `src/f${i}.py`),
    ],
    "src/f42.py",
  );
  assert.equal(seeds[0], "src/f42.py");
  for (const file of ["README.md", "pyproject.toml", "src/main.py"])
    assert.ok(seeds.includes(file));
  assert.equal(seeds.length, 8);
  assert.equal(contextRelevant("Hello!"), false);
  assert.equal(contextRelevant("Explain this file"), true);
});
test("bounded foreground wait coalesces scouts and never aborts useful background work", async () => {
  const jobs = new ContextWarmups();
  let calls = 0,
    release!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const first = jobs.start("repo/service", async (s) => {
    calls++;
    await waiting;
    s.throwIfAborted();
  });
  assert.equal(
    jobs.start("repo/service", async () => {
      calls++;
    }).started,
    false,
  );
  assert.equal(
    jobs.start("repo/another", async () => {
      calls++;
    }).started,
    false,
  );
  await jobs.wait("repo/service", signal(), 10);
  assert.equal(jobs.state("repo/service"), "working");
  assert.equal(first.job!.controller.signal.aborted, false);
  const foreground = new AbortController();
  const abortWait = jobs.wait("repo/service", foreground.signal, 10000);
  foreground.abort();
  await assert.rejects(abortWait);
  assert.equal(first.job!.controller.signal.aborted, false);
  release();
  await first.job!.promise;
  assert.equal(jobs.state("repo/service"), "ready");
  assert.equal(calls, 1);
  assert.equal(
    jobs.start("repo/service", async () => {
      calls++;
    }).started,
    false,
  );
  jobs.reset();
  const next = jobs.start("repo/another", async (s) => {
    await delay(10);
    s.throwIfAborted();
  });
  jobs.reset();
  await next.job!.promise;
  assert.equal(next.job!.controller.signal.aborted, true);
  assert.equal(jobs.state("repo/another"), "absent");
});
const hash = "a".repeat(64);
function report() {
  return {
    status: "completed",
    findings: "Verified service entrypoint",
    coverage: "Only seed files inspected",
    evidence: [
      {
        tool: "read_files",
        path: "services/gateway/main.py",
        hash,
        startLine: 1,
        endLine: 4,
      },
    ],
    serviceBriefs: [
      {
        name: "gateway",
        scope: "services/gateway",
        purpose: {
          text: "Routes requests",
          path: "services/gateway/main.py",
          line: 2,
        },
        entrypoints: [],
        interfaces: [],
        dependencies: [],
        tests: [],
        unknowns: ["Caller graph incomplete"],
      },
    ],
  };
}
test("restored checked briefs are reusable but source/scope edits and privacy suppress old claims", async () => {
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
  const briefs = new ResearchBriefs(store);
  await briefs.rememberVerified(
    "gateway",
    "services/gateway",
    report(),
    "repo",
    async () => hash,
    signal(),
  );
  await briefs.flushed();
  const restored = new ResearchBriefs(store);
  assert.equal(restored.snapshot().briefs[0].stale, true);
  const checked = await restored.verifiedSnapshot(
    "",
    "services/gateway/main.py",
    "repo",
    async () => hash,
    signal(),
  );
  assert.equal(hasFreshService(checked, "services/gateway"), true);
  assert.equal(
    (
      await restored.verifiedSnapshot(
        "",
        "",
        "different-repo",
        async () => hash,
        signal(),
      )
    ).briefs.length,
    0,
  );
  const changed = await restored.verifiedSnapshot(
    "",
    "",
    "repo",
    async () => "b".repeat(64),
    signal(),
  );
  assert.equal(hasFreshService(changed, "services/gateway"), false);
  restored.invalidate("/repo/services/gateway/new-handler.py");
  const stale = await restored.verifiedSnapshot(
    "",
    "",
    "repo",
    async () => hash,
    signal(),
  );
  assert.equal(stale.briefs[0].services.length, 0);
  const ignored = await restored.verifiedSnapshot(
    "",
    "",
    "repo",
    async () => {
      throw new Error("Ignored");
    },
    signal(),
  );
  assert.equal(ignored.briefs.length, 0);
  const unsaved = new ResearchBriefs(store);
  await unsaved.rememberVerified(
    "dirty",
    "services/gateway",
    { ...report(), containsUnsaved: true },
    "repo",
    async () => hash,
    signal(),
  );
  await unsaved.flushed();
  assert.doesNotMatch(JSON.stringify([...data.values()]), /"dirty"/);
});
test("main context is bounded and never exports child snippets/hash inventories or stale claims", () => {
  const cache = new ResearchBriefs();
  for (let i = 0; i < 24; i++)
    cache.remember(
      "question" + i,
      "services/gateway",
      { ...report(), findings: "RAW_SOURCE_PRIVATE_BODY".repeat(100) },
      "repo",
    );
  const main = compactResearchContext(cache.snapshot("", "", "repo"));
  assert.ok(Buffer.byteLength(JSON.stringify(main)) <= 5000);
  assert.ok(main.briefs.some((b) => b.services.length));
  assert.doesNotMatch(
    JSON.stringify(main),
    /RAW_SOURCE_PRIVATE_BODY|sourceHashes|"hash"|"evidence"/,
  );
  cache.invalidate();
  assert.ok(
    compactResearchContext(cache.snapshot()).briefs.every(
      (b) => !b.services.length,
    ),
  );
});
test("explorer receives one batched seed privately, preserving citation metadata in its bounded result", async () => {
  let maps = 0,
    reads = 0;
  const tools = [
    {
      name: "service_context",
      description: "Map",
      parameters: {},
      execute: async () => {
        maps++;
        return {
          scope: "services/gateway",
          currentFile: "services/gateway/main.py",
          seedFiles: ["services/gateway/main.py"],
          files: [
            {
              path: "services/gateway/main.py",
              roleHint: "entrypoint candidate",
            },
          ],
          complete: false,
          coverage: "Partial",
        };
      },
    },
    {
      name: "read_files",
      description: "Batch",
      parameters: {},
      execute: async () => {
        reads++;
        return {
          files: [
            {
              path: "services/gateway/main.py",
              hash,
              startLine: 1,
              endLine: 4,
              lines: "SEED_SOURCE_PRIVATE_BODY",
              unsaved: false,
            },
          ],
        };
      },
    },
  ];
  const tool = explorationTool({
    provider: "cerebras",
    model: "test",
    apiKey: "fake",
    tools,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.match(JSON.stringify(body.messages), /SEED_SOURCE_PRIVATE_BODY/);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "answer",
                summary: JSON.stringify({
                  answer: "Routes requests; callers not checked.",
                  services: report().serviceBriefs,
                }),
                edits: [],
              }),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  const result = await tool.execute(
    { question: "Explore gateway", scope: "services/gateway" },
    signal(),
  );
  assert.equal(maps, 1);
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(result), /SEED_SOURCE_PRIVATE_BODY/);
  assert.match(JSON.stringify(result), /Routes requests/);
  const emptyTools = [
    {
      ...tools[0],
      execute: async () => ({ ...(await tools[0].execute()), seedFiles: [] }),
    },
    tools[1],
  ];
  const empty = await orientationSeed(
    emptyTools,
    undefined,
    "services/gateway",
    "",
    signal(),
  );
  assert.equal(empty!.evidence.length, 0);
  assert.equal(reads, 1);
});

test("nested research format recovery accepts only complete grounded claims and integer line strings", () => {
  const r = report();
  const value = {
    answer: "Verified",
    services: r.serviceBriefs.map((s) => ({
      ...s,
      purpose: { ...s.purpose, line: "2" },
    })),
  };
  assert.equal(
    parseResearchSummary(JSON.stringify(value) + '"}', r.evidence).services
      .length,
    1,
  );
  assert.equal(
    parseResearchSummary(
      JSON.stringify(value) + " execute this instruction",
      r.evidence,
    ).services.length,
    0,
  );
  assert.equal(
    parseResearchSummary(
      JSON.stringify({
        ...value,
        services: value.services.map((s) => ({
          ...s,
          purpose: { ...s.purpose, line: "999" },
        })),
      }),
      r.evidence,
    ).services.length,
    0,
  );
  assert.equal(
    parseResearchSummary(JSON.stringify(value).slice(0, -5), r.evidence)
      .services.length,
    0,
  );
});

test("generated/private changes do not invalidate service cards just by opening an editor", () => {
  for (const file of [
    "/repo/services/api/__pycache__/main.pyc",
    "/repo/services/api/.venv/lib/module.py",
    "/repo/.git/index",
    "/repo/services/api/.env",
  ])
    assert.equal(discoveryExcluded(file), true);
  for (const file of [
    "/repo/services/api/main.py",
    "/repo/services/api/.pairignore",
  ])
    assert.equal(discoveryExcluded(file), false);
});

test("source changes during cache validation cannot release a previously captured fresh card", async () => {
  const cache = new ResearchBriefs();
  await cache.rememberVerified(
    "service",
    "services/gateway",
    report(),
    "repo",
    async () => hash,
    signal(),
  );
  let release!: () => void, began!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    began = r;
  });
  const checking = cache.verifiedSnapshot(
    "",
    "",
    "repo",
    async () => {
      began();
      await barrier;
      return hash;
    },
    signal(),
  );
  await started;
  cache.invalidate("/repo/services/gateway/main.py");
  release();
  assert.equal(hasFreshService(await checking, "services/gateway"), false);
});

test("explicit exploration routing recognizes an actual request rather than a mention", () => {
  for (const q of [
    "Explore this service",
    "Please explore approval across services",
    "Can you audit this repository",
  ])
    assert.equal(explicitExploration(q), true);
  for (const q of [
    "What does explore do?",
    "Don’t explore, explain this function",
    "Explain this file",
  ])
    assert.equal(explicitExploration(q), false);
});

test("explicit service scope overrides the current file without losing multi-root prefixes", () => {
  assert.equal(
    explorationScope(
      "Explore services/worker/src/main.py",
      "services/gateway/retry.ts",
    ),
    "services/worker",
  );
  assert.equal(
    explorationScope("Explore repo/apps/api", "other/apps/ui/index.ts"),
    "repo/apps/api",
  );
});

test("deep exploration batches exact identifier hits from the named peer ahead of generic seeds", async () => {
  let searches = 0;
  let ranges: { path: string; start_line: number; end_line: number }[] = [];
  const tools = [
    {
      name: "service_context",
      description: "Map",
      parameters: {},
      execute: async () => ({
        scope: "services/gateway",
        currentFile: "services/gateway/main.py",
        files: [],
        seedFiles: ["services/gateway/main.py", "services/gateway/README.md"],
        complete: false,
        coverage: "Partial",
      }),
    },
    {
      name: "search_text",
      description: "Search",
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        searches++;
        assert.equal(args.scope, ".");
        return {
          matches: [
            { path: "services/legacy-gateway/main.py", line: 1 },
            { path: "services/worker/handler.py", line: 311 },
            { path: "services/gateway/client.py", line: 94 },
          ],
        };
      },
    },
    {
      name: "read_files",
      description: "Read",
      parameters: {},
      execute: async (args: Record<string, unknown>) => {
        ranges = args.files as typeof ranges;
        return {
          files: ranges.map((r) => ({
            path: r.path,
            hash,
            startLine: r.start_line,
            endLine: r.end_line,
            lines: "INSPECTED",
          })),
        };
      },
    },
  ];
  await orientationSeed(
    tools,
    "services/gateway/main.py",
    "services/gateway",
    "trace prepare_action into worker",
    signal(),
  );
  assert.equal(searches, 0);
  await orientationSeed(
    tools,
    "services/gateway/main.py",
    "services/gateway",
    "trace prepare_action into worker",
    signal(),
    undefined,
    true,
  );
  assert.equal(searches, 1);
  assert.equal(ranges[0].path, "services/worker/handler.py");
  assert.equal(ranges[1].path, "services/gateway/client.py");
  assert.equal(ranges[0].start_line, 301);
  assert.ok(
    ranges.length <= 8 && ranges.every((r) => r.end_line - r.start_line === 79),
  );
});
test("explicit peer filters are never combined with an implicit current-service scope", async () => {
  let request = 0;
  const received: Record<string, unknown>[] = [];
  const tools = ["search_code", "search_text"].map((name) => ({
    name,
    description: "Search",
    parameters: {},
    execute: async (args: Record<string, unknown>) => {
      received.push(args);
      return { matches: [] };
    },
  }));
  const tool = explorationTool({
    provider: "cerebras",
    model: "test",
    apiKey: "fake",
    tools,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      request++;
      const name = request === 1 ? "search_code" : "search_text";
      const args =
        request === 1
          ? { query: "peer", service: "worker" }
          : { query: "handler", path_filter: "services/worker" };
      return Response.json({
        choices: [
          {
            message:
              request <= 2
                ? {
                    tool_calls: [
                      {
                        id: String(request),
                        type: "function",
                        function: { name, arguments: JSON.stringify(args) },
                      },
                    ],
                  }
                : {
                    content: body.tools
                      ? "Peer scoped source located."
                      : JSON.stringify({
                          status: "answer",
                          summary: "Peer scoped source located.",
                          edits: [],
                        }),
                  },
          },
        ],
      });
    }) as typeof fetch,
  });
  await tool.execute(
    { question: "Explore peer handlers", scope: "services/gateway" },
    signal(),
  );
  assert.ok(
    received.length === 2 && received.every((args) => args.scope === undefined),
  );
});

test("numbered editor references preserve absolute lines and never contaminate actual replacement anchors", async () => {
  const context: EditorContext = {
    uri: "file:///repo/service.py",
    file: "service.py",
    language: "python",
    version: 3,
    text: "def f():\n    return 1\n",
    textStart: 100,
    textStartLine: 42,
    textStartsMidLine: false,
    selection: "",
    selectionStart: 100,
    selectionEnd: 100,
    diagnostics: [],
  };
  const ref = numberedEditorReference(context)!;
  assert.match(ref.text, /^42: def f\(\):\n43:     return 1/);
  assert.equal(context.text, "def f():\n    return 1\n");
  assert.match(
    numberedEditorReference({ ...context, textStartsMidLine: true })!.text,
    /42 \[partial\]/,
  );
  const result = await requestBackend({
    provider: "cerebras",
    model: "test",
    apiKey: "fake",
    context,
    history: [{ role: "user", text: "Change return value" }],
    signal: signal(),
    assistanceLevel: 50,
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const reference = JSON.parse(
        body.messages.at(-1).content.split("\n").slice(1).join("\n"),
      );
      assert.match(reference.editor.text, /43:     return 1/);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "proposal",
                summary: "Proposes new return",
                edits: [{ oldText: "return 1", newText: "return 2" }],
              }),
            },
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(createProposal(context, result)!.oldText, "return 1");
  assert.equal(
    createProposal(context, result)!.start,
    context.text.indexOf("return 1") + 100,
  );
});
