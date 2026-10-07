import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceDiscovery } from "../extension/src/discovery.js";
import { requestBackend } from "../extension/src/backend.js";
import { ToolFailure, isToolFailure } from "../extension/src/tool-errors.js";
import { explorationTool } from "../extension/src/exploration.js";
const bundledRg = path.resolve(
  import.meta.dirname,
  "../.runtime/VSCodium.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "rg.exe" : "rg",
);
const rg = existsSync(bundledRg) ? bundledRg : "rg";
const signal = () => new AbortController().signal;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "pair-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name: string, contents = "value = 1\n") => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
    return file;
  };
  return { root, put };
}
test("scoped pages skip nested generated folders and preserve ignore rules", async (t) => {
  const { root, put } = await fixture(t);
  await put(".gitignore", "ignored.py\n");
  await put(".pairignore", "services/ner/private/\n");
  await put("services/ner/.ignore", "scratch.py\n");
  for (const name of [
    "main.py",
    "extractor.py",
    "ignored.py",
    "scratch.py",
    ".env",
    "private/data.py",
    "node_modules/dep.py",
    ".venv/lib.py",
    "__pycache__/a.py",
  ])
    await put(`services/ner/${name}`);
  await put("services/other/entry.py");
  await put(".worktrees/another/services/ner/main.py");
  const discovery = new WorkspaceDiscovery([{ name: "repo", path: root }], rg);
  const page1 = await discovery.page(
    { scope: "services/ner", query: ".py", limit: 1 },
    signal(),
  );
  assert.equal(page1.complete, false);
  assert.equal(page1.nextOffset, 1);
  const page2 = await discovery.page(
    { scope: "services/ner", query: ".py", limit: 1, offset: page1.nextOffset },
    signal(),
  );
  assert.equal(page2.complete, true);
  assert.deepEqual(
    [...page1.files, ...page2.files].map((f) => discovery.label(f)),
    ["services/ner/extractor.py", "services/ner/main.py"],
  );
  const overview = (await discovery.overview("services", signal())) as {
    entries: { path: string }[];
  };
  assert.deepEqual(
    overview.entries.map((e) => e.path),
    ["services/ner", "services/other"],
  );
  const walked: string[] = [];
  for await (const file of discovery.walk(signal())) walked.push(file);
  assert.ok(walked.some(f => f.endsWith("extractor.py")));
  assert.ok(walked.every(f => !/node_modules|\.venv|\.worktrees|private|scratch\.py|ignored\.py/.test(f)));
  const all = await discovery.page({}, signal());
  assert.ok(
    all.files.every(
      (f) => !f.includes(".worktrees") && !f.includes("node_modules"),
    ),
  );
  for (const name of [
    "ignored.py",
    "scratch.py",
    ".env",
    "private/data.py",
    "node_modules/dep.py",
  ])
    await assert.rejects(
      discovery.resolve(`services/ner/${name}`, signal()),
      /excluded/,
    );
  assert.equal(
    await discovery.resolve("services/ner/main.py", signal()),
    path.join(root, "services/ner/main.py"),
  );
});
test("known paths do not invoke discovery; traversal and symlink ignore escapes are denied", async (t) => {
  const { root, put } = await fixture(t);
  await put("src/main.py");
  await put(".pairignore", "private/\n");
  await put("private/data.py");
  await symlink(
    path.join(root, "private/data.py"),
    path.join(root, "src/alias.py"),
  );
  const discovery = new WorkspaceDiscovery(
    [{ name: "repo", path: root }],
    "/missing/rg",
  );
  assert.equal(
    await discovery.resolve("src/main.py", signal()),
    path.join(root, "src/main.py"),
  );
  await assert.rejects(discovery.resolve("src/alias.py", signal()), /excluded/);
  await assert.rejects(
    discovery.resolve("../outside.py", signal()),
    /absent|outside/,
  );
  await assert.rejects(
    discovery.page({}, signal()),
    (error: unknown) =>
      isToolFailure(error) && error.domain === "workspace.discovery",
  );
  assert.equal(
    await discovery.resolve("src/main.py", signal()),
    path.join(root, "src/main.py"),
  );
});
test("streaming handles more than two megabytes of path output without a global inventory", async (t) => {
  const { root, put } = await fixture(t);
  const fake = await put(
    "fake-rg.cjs",
    `#!${process.execPath}\nfor(let i=0;i<60000;i++) process.stdout.write('services/irrelevant/'+String(i).padStart(6,'0')+'/'+'x'.repeat(50)+'.py\\0'); process.stdout.write('services/ner/wanted.py\\0');`,
  );
  await chmod(fake, 0o755);
  const discovery = new WorkspaceDiscovery(
    [{ name: "repo", path: root }],
    fake,
  );
  const page = await discovery.page({ query: "wanted" }, signal());
  assert.deepEqual(
    page.files.map((f) => discovery.label(f)),
    ["services/ner/wanted.py"],
  );
  assert.equal(page.complete, true);
});
test("cancelled discovery does not poison later requests or workspaces opened inside worktrees", async (t) => {
  const { root, put } = await fixture(t);
  const fake = await put(
    "fake-rg.cjs",
    `#!${process.execPath}\nsetTimeout(()=>process.stdout.write('main.py\\0'),10000);`,
  );
  await chmod(fake, 0o755);
  const discovery = new WorkspaceDiscovery(
    [{ name: "repo", path: root }],
    fake,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(discovery.page({}, controller.signal));
  await writeFile(
    fake,
    `#!${process.execPath}\nprocess.stdout.write('main.py\\0');`,
  );
  assert.equal((await discovery.page({}, signal())).files.length, 1);
  const worktree = path.join(root, ".worktrees/active");
  await put(".worktrees/active/main.py");
  const scoped = new WorkspaceDiscovery(
    [{ name: "active", path: worktree }],
    rg,
  );
  assert.equal((await scoped.page({}, signal())).files.length, 1);
  assert.equal(
    await scoped.resolve("main.py", signal()),
    path.join(worktree, "main.py"),
  );
});
const base = {
  provider: "cerebras" as const,
  model: "test",
  apiKey: "test",
  signal: signal(),
  history: [{ role: "user" as const, text: "Explore service" }],
};
function answer(summary = "Known file inspected; discovery unavailable.") {
  return { content: JSON.stringify({ status: "answer", summary, edits: [] }) };
}
function tool(name: string, args: object, id: string) {
  return {
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}
test("shared discovery failure blocks retries while independent known-file reads continue", async () => {
  let enumeration = 0,
    reads = 0,
    requests = 0;
  const result = await requestBackend({
    ...base,
    tools: [
      ...["find_files", "search_text"].map((name) => ({
        name,
        description: "Discover",
        failureDomain: "workspace.discovery",
        parameters: {},
        execute: async () => {
          enumeration++;
          throw new ToolFailure(
            "discovery_unavailable",
            "Discovery offline",
            "workspace.discovery",
          );
        },
      })),
      {
        name: "read_file",
        description: "Read",
        parameters: {},
        execute: async () => {
          reads++;
          return { path: "main.py", lines: "1: app = 1" };
        },
      },
    ],
    fetchImpl: (async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      if (requests === 3) {
        const messages = body.messages.filter(
          (m: { role: string }) => m.role === "tool",
        );
        assert.equal(messages.length, 2);
        assert.match(messages[1].content, /discovery_unavailable/);
      }
      const message =
        requests === 1
          ? tool("find_files", { query: "ner" }, "a")
          : requests === 2
            ? tool("search_text", { query: "extractor" }, "b")
            : requests === 3
              ? tool("read_file", { path: "main.py" }, "c")
              : answer();
      return Response.json({ choices: [{ message }] });
    }) as typeof fetch,
  });
  assert.equal(enumeration, 1);
  assert.equal(reads, 1);
  assert.equal(result.status, "answer");
});
test("repeated failed calls are cached and finalized without retry storms", async () => {
  let executions = 0,
    requests = 0;
  await requestBackend({
    ...base,
    tools: [
      {
        name: "read_file",
        description: "Read",
        parameters: {},
        execute: async () => {
          executions++;
          throw new Error("File excluded");
        },
      },
    ],
    fetchImpl: (async (_url, init) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      return Response.json({
        choices: [
          {
            message: body.tools
              ? tool("read_file", { path: "missing.py" }, String(requests))
              : answer("File could not be inspected."),
          },
        ],
      });
    }) as typeof fetch,
  });
  assert.equal(executions, 1);
  assert.ok(requests <= 5);
});
test("explorer is local-only, scoped, uses research effort, and exports no source snippets", async () => {
  let requests = 0,
    received: unknown;
  const explorer = explorationTool({
    ...base,
    effort: "none",
    context: {
      uri: "file:///services/ner/main.py",
      file: "services/ner/main.py",
      language: "python",
      version: 1,
      text: "UNRELATED_EDITOR_SOURCE",
      selection: "",
      selectionStart: 0,
      selectionEnd: 0,
      diagnostics: [],
    },
    tools: [
      {
        name: "search_text",
        description: "Search",
        parameters: {},
        execute: async (args) => {
          received = args;
          return {
            scope: args.scope,
            complete: false,
            matches: Array.from({ length: 40 }, (_, i) => ({
              path: `services/ner/f${i}.py`,
              line: 1,
              text: "PRIVATE_SOURCE_BODY".repeat(50),
            })),
          };
        },
      },
      {
        name: "web_search",
        description: "Web",
        parameters: {},
        execute: async () => {
          throw new Error("Web should be unavailable");
        },
      },
    ],
    fetchImpl: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests++;
      assert.equal(body.reasoning_effort, "medium");
      assert.doesNotMatch(
        JSON.stringify(body.messages.slice(0, 3)),
        /UNRELATED_EDITOR_SOURCE/,
      );
      if (requests === 1) {
        assert.deepEqual(
          body.tools.map(
            (t: { function: { name: string } }) => t.function.name,
          ),
          ["search_text"],
        );
        return Response.json({
          choices: [
            { message: tool("search_text", { query: "Extractor" }, "a") },
          ],
        });
      }
      return Response.json({
        choices: [
          {
            message: answer(
              "services/ner/f0.py:1 contains the entrypoint. Other callers unchecked.",
            ),
          },
        ],
      });
    }) as typeof fetch,
  });
  const report = await explorer.execute(
    { question: "Explore ner", scope: "services/ner" },
    signal(),
  );
  assert.deepEqual(received, { query: "Extractor", scope: "services/ner" });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SOURCE_BODY/);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 14000);
});

test("long path pages preserve a usable continuation instead of overflowing the backend result", async (t) => {
  const { root, put } = await fixture(t);
  const fake = await put(
    "fake-rg.cjs",
    `#!${process.execPath}\nfor(let i=0;i<100;i++) process.stdout.write('services/ner/'+'nested/'.repeat(180)+'f'+i+'.py\\0');`,
  );
  await chmod(fake, 0o755);
  const discovery = new WorkspaceDiscovery(
    [{ name: "repo", path: root }],
    fake,
  );
  const first = await discovery.page({ limit: 80 }, signal());
  assert.equal(first.complete, false);
  assert.ok(first.files.length < 80 && first.files.length > 0);
  assert.equal(first.nextOffset, first.files.length);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify(first.files.map((f) => discovery.label(f))),
    ) < 21000,
  );
  const next = await discovery.page(
    { limit: 80, offset: first.nextOffset },
    signal(),
  );
  assert.notEqual(next.files[0], first.files[0]);
});

test("native search finds cross-service source matches and overlays unsaved removals without paging through unrelated files", async (t) => {
  const { root, put } = await fixture(t);
  for (let i = 0; i < 130; i++)
    await put(
      `services/aaa/f${String(i).padStart(3, "0")}.py`,
      "unrelated = 1\n",
    );
  const target = await put(
    "services/consumer/src/main.py",
    "old_disk_match copilot-mcp\n",
  );
  await put("services/consumer/src/client.py", "call_url = 'copilot-mcp'\n");
  await put(".worktrees/another/secret.py", "copilot-mcp SECRET_GENERATED\n");
  await put("services/consumer/.env", "copilot-mcp PRIVATE_KEY\n");
  await put(".pairignore", "services/consumer/private.py\n");
  await put("services/consumer/private.py", "copilot-mcp PRIVATE_CODE\n");
  const discovery = new WorkspaceDiscovery([{ name: "repo", path: root }], rg);
  const result = await discovery.search(
    {
      query: "copilot-mcp",
      pathFilter: "src/",
      overlays: [
        { file: target, text: "unsaved_removed_match = True\n", version: 7 },
      ],
    },
    signal(),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.matches.map((m) => discovery.label(m.file)),
    ["services/consumer/src/client.py"],
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /old_disk_match|SECRET_GENERATED|PRIVATE_KEY|PRIVATE_CODE/,
  );
  const overlay = await discovery.search(
    {
      query: "updated",
      scope: "services/consumer",
      overlays: [{ file: target, text: "updated = True\n", version: 8 }],
    },
    signal(),
  );
  assert.equal(overlay.matches[0].version, 8);
  assert.equal(overlay.matches[0].source, "unsaved_buffer");
});
test("native search pages by matching lines and preserves coverage for negative results", async (t) => {
  const { root, put } = await fixture(t);
  await put(
    "main.py",
    Array.from({ length: 75 }, (_, i) => `needle line ${i}`).join("\n"),
  );
  const discovery = new WorkspaceDiscovery([{ name: "repo", path: root }], rg);
  const first = await discovery.search({ query: "needle" }, signal());
  const last = await discovery.search(
    { query: "needle", offset: first.nextOffset },
    signal(),
  );
  assert.equal(first.matches.length, 40);
  assert.equal(first.nextOffset, 40);
  assert.equal(first.complete, false);
  assert.equal(last.matches.length, 35);
  assert.equal(last.matches[0].line, 41);
  assert.equal(last.complete, true);
  const none = await discovery.search({ query: "missing symbol" }, signal());
  assert.equal(none.complete, true);
  assert.match(none.coverage, /unchecked/);
  await assert.rejects(
    discovery.search({ query: "line1\nline2" }, signal()),
    /single-line/,
  );
});
