import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import type { AgentSettings } from "../extension/src/agent-settings.js";
const requireNative = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: ["extension/src/agent-settings.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  write: false,
});

test("Settings reuses its page, validates General actions and saves through native configuration", async () => {
  let receive: (data: unknown) => Promise<void> = async () => {};
  let configurationChanged = () => {},
    themeChanged = () => {};
  let opened = 0,
    revealed = 0,
    disposed = 0,
    reloads = 0;
  const posts: Record<string, unknown>[] = [],
    updates: unknown[][] = [],
    commands: string[] = [];
  const panel = {
    reveal: () => revealed++,
    dispose: () => disposed++,
    onDidDispose: () => ({ dispose() {} }),
    webview: {
      html: "",
      cspSource: "fixture",
      asWebviewUri: (x: unknown) => x,
      postMessage: (m: Record<string, unknown>) => posts.push(m),
      onDidReceiveMessage: (fn: typeof receive) => {
        receive = fn;
      },
    },
  };
  const native = {
    ConfigurationTarget: { Global: 1 },
    ViewColumn: { Active: 1 },
    Uri: { joinPath: (...parts: unknown[]) => parts.join("/") },
    workspace: {
      fs: { readFile: async () => Buffer.from("<html>Settings</html>") },
      onDidChangeConfiguration: (fn: () => void) => {
        configurationChanged = fn;
        return { dispose: () => disposed++ };
      },
      getConfiguration: (scope: string) => ({
        update: async (...args: unknown[]) => {
          if (args[1] === "automatic")
            throw new Error("Unable to save preference");
          updates.push([scope, ...args]);
        },
      }),
    },
    window: {
      createWebviewPanel: () => {
        opened++;
        return panel;
      },
      onDidChangeActiveColorTheme: (fn: () => void) => {
        themeChanged = fn;
        return { dispose: () => disposed++ };
      },
      showErrorMessage: () => assert.fail("page load failed"),
    },
    commands: {
      executeCommand: async (command: string) => commands.push(command),
    },
  };
  const module = { exports: {} } as {
    exports: { AgentSettings: typeof AgentSettings };
  };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    (name: string) => (name === "vscode" ? native : requireNative(name)),
    module,
    module.exports,
  );
  const definitions = {
    reload: async () => {
      reloads++;
    },
    agents: {},
    tools: {},
    policy: {},
    revision: "test",
  };
  const settings = new module.exports.AgentSettings(
    { extensionUri: "fixture" } as never,
    async () => {},
    async () => undefined,
    definitions as never,
    { history: [] } as never,
    () => {},
    () => [],
    () => ({
      inlineMode: "manual",
      theme: "light",
      indexStatus: { state: "ready", files: 2 },
    }),
  );
  settings.open();
  await receive({ type: "ready" });
  assert.equal(opened, 1);
  assert.equal(reloads, 1);
  assert.ok(posts.some((p) => p.type === "general"));
  assert.ok(
    posts.some((p) => p.type === "navigate" && p.section === "general"),
  );
  posts.length = 0;
  settings.open("agents");
  assert.equal(opened, 1);
  assert.equal(revealed, 1);
  assert.equal(reloads, 1);
  assert.equal(
    posts.some((p) => p.type === "settings"),
    false,
    "revealing must not overwrite definition drafts",
  );
  assert.ok(posts.some((p) => p.type === "navigate" && p.section === "agents"));
  for (const [key, value] of [
    ["inlineMode", "off"],
    ["shareContext", false],
    ["followPair", false],
    ["indexEnabled", false],
    ["theme", "dark"],
  ])
    await receive({ type: "generalChange", key, value });
  assert.deepEqual(updates, [
    ["pairCode", "inlineSuggestions", "off", 1],
    ["pairCode", "shareEditorContext", false, 1],
    ["pairCode", "followPair", false, 1],
    ["pairCode", "indexEnabled", false, 1],
    ["workbench", "colorTheme", "Zen Dark", 1],
  ]);
  for (const [key, value] of [
    ["__proto__", true],
    ["followPair", "false"],
    ["inlineMode", "other"],
    ["theme", "arbitrary"],
    ["apiKey", "secret"],
  ]) {
    await receive({ type: "generalChange", key, value });
    assert.equal(posts.at(-1)?.type, "generalError");
  }
  assert.equal(updates.length, 5);
  await receive({
    type: "generalChange",
    key: "inlineMode",
    value: "automatic",
  });
  assert.equal(posts.at(-1)?.type, "generalError");
  assert.equal(
    posts.at(-2)?.inlineMode,
    "manual",
    "failed save restores actual preference",
  );
  await receive({ type: "generalAction", action: "editorSettings" });
  await receive({ type: "generalAction", action: "refreshIndex" });
  await receive({ type: "generalAction", action: "workbench.action.quit" });
  assert.deepEqual(commands, [
    "workbench.action.openSettings",
    "pairCode.refreshIndex",
  ]);
  posts.length = 0;
  configurationChanged();
  themeChanged();
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => p.type === "general"));
  settings.dispose();
  assert.equal(disposed, 3);
});
