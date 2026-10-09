import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1080 },
  });
  await page.addInitScript(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.messages.push(m),
    });
  });
  // Load actual assets with a simulated host; no network or model calls.
  await page.route("https://agents.test/**", (route) =>
    route.fulfill({ body: "<html></html>", contentType: "text/html" }),
  );
  await page.goto("https://agents.test/");
  await page.evaluate(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.messages.push(m),
    });
  });
  const html = (await readFile("extension/media/agents.html", "utf8"))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace(/<link[^>]*>/, "")
    .replace(/<script[^>]*><\/script>/, "");
  await page.setContent(html);
  await page.addStyleTag({
    content: await readFile("extension/media/agents.css", "utf8"),
  });
  await page.addScriptTag({
    content: await readFile("extension/media/agents.js", "utf8"),
  });
  assert.deepEqual(await page.evaluate(() => window.messages), [
    { type: "ready" },
  ]);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  assert.equal(await page.locator("#generalPage").isVisible(), true);
  assert.equal(await page.locator("#profiles").isVisible(), false);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "general",
          theme: "light",
          inlineMode: "manual",
          shareContext: true,
          followPair: true,
          indexEnabled: true,
          contextFile: "src/<script>test</script>.py",
          indexStatus: {
            state: "ready",
            files: 2,
            chunks: 5,
            coverageKnown: true,
          },
        },
      }),
    ),
  );
  assert.equal(await page.locator("#contextFile script").count(), 0);
  assert.match(
    await page.locator("#contextFile").textContent(),
    /<script>test/,
  );
  for (const [key, value] of [
    ["theme", "dark"],
    ["inlineMode", "off"],
    ["shareContext", false],
    ["followPair", false],
    ["indexEnabled", false],
  ]) {
    if (typeof value === "boolean") await page.locator(`#${key}`).uncheck();
    else await page.locator(`#${key}`).selectOption(value);
    const message = await page.evaluate(() => window.messages.at(-1));
    assert.equal(message.type, "generalChange");
    assert.equal(message.key, key);
    assert.equal(message.value, value);
  }
  for (const action of [
    "applyLayout",
    "manageMemory",
    "showTrace",
    "refreshIndex",
    "editorSettings",
    "keyboardSettings",
  ]) {
    await page.locator(`#${action}`).click();
    const message = await page.evaluate(() => window.messages.at(-1));
    assert.equal(message.type, "generalAction");
    assert.equal(message.action, action);
  }
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "general",
          indexStatus: {
            state: "indexing",
            processed: 3,
            total: 10,
            currentFile: "src/main.py",
            repository: "demo",
            embedded: 4,
            reused: 2,
          },
        },
      }),
    ),
  );
  assert.match(await page.locator("#indexStatus").textContent(), /3 \/ 10/);
  assert.equal(await page.locator("#indexProgress").getAttribute("value"), "3");
  assert.match(
    await page.locator("#indexDetail").textContent(),
    /src\/main.py/,
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "general",
          indexStatus: {
            state: "error",
            error: "Embedding request failed (429).",
          },
        },
      }),
    ),
  );
  assert.equal(await page.locator("#indexError").isVisible(), true);
  assert.match(await page.locator("#indexError").textContent(), /429/);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "general", indexStatus: { state: "ready", files: 8 } },
      }),
    ),
  );
  assert.equal(await page.locator("#indexProgress").isVisible(), false);
  assert.equal(await page.locator("#indexError").isVisible(), false);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "general",
          indexStatus: {
            state: "connecting",
            shared: true,
            files: 0,
          },
        },
      }),
    ),
  );
  assert.equal(await page.locator("#indexError").isVisible(), false);
  assert.match(await page.locator("#indexDetail").textContent(), /unavailable/);
  assert.doesNotMatch(
    await page.locator("#indexDetail").textContent(),
    /0 chunks/,
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "general",
          indexStatus: {
            state: "ready",
            files: 8,
            chunks: 24,
            coverageKnown: true,
            processed: 0,
            embedded: 0,
            reused: 0,
          },
        },
      }),
    ),
  );
  assert.match(
    await page.locator("#indexDetail").textContent(),
    /8 files · 24 chunks stored/,
  );

  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "general",
          indexStatus: {
            state: "ready",
            files: 8,
            chunks: 24,
            coverageKnown: true,
            pendingEmbeddings: 3,
            nextEmbeddingAt: Date.now() + 30 * 60000,
          },
        },
      }),
    ),
  );
  assert.match(
    await page.locator("#indexStatus").textContent(),
    /Search ready.*3 files awaiting embeddings/,
  );
  assert.match(
    await page.locator("#indexDetail").textContent(),
    /searchable by text now/,
  );
  assert.equal(await page.locator("#indexProgress").isVisible(), false);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "general",
          indexStatus: {
            state: "error",
            files: 8,
            pendingEmbeddings: 3,
            error: "Synthetic embedding outage",
          },
        },
      }),
    ),
  );
  assert.match(
    await page.locator("#indexStatus").textContent(),
    /Text search ready/,
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "general",
          indexStatus: {
            state: "ready",
            files: 8,
            pendingEmbeddings: 0,
          },
        },
      }),
    ),
  );
  await page.locator("#agentsTab").click();
  const agents = {
    explorer: {
      name: "Explorer",
      description: "Discovery",
      mode: "foreground",
      orientation: true,
      tools: ["read_file"],
      workspace: "shared",
      enabled: true,
      model: "deepseek-ai/DeepSeek-V4.1-Flash",
      reasoningEffort: "medium",
      instructions: "Source-backed discovery and summaries.",
    },
    deep_research: {
      name: "Deep research",
      description: "Complex questions",
      mode: "background",
      orientation: false,
      tools: ["read_file"],
      workspace: "shared",
      enabled: true,
      model: "deepseek-ai/DeepSeek-V4-Pro-0813",
      reasoningEffort: "high",
      instructions: "Inspect both sides of cross-service contracts.",
    },
  };
  const models = [
    agents.explorer.model,
    agents.deep_research.model,
    "zai-org/GLM-5.3-Flash",
  ];
  await page.evaluate(
    (data) => window.dispatchEvent(new MessageEvent("message", { data })),
    {
      type: "settings",
      agents,
      models,
      togetherReady: true,
      builtin: ["read_file", "apply_patch"],
      tools: {},
      policy: { mainTools: ["read_file"], disabled: [] },
      revision: "fixture",
    },
  );
  assert.equal(await page.locator("#explorer-model").inputValue(), models[0]);
  assert.equal(
    await page.locator("#deep_research-effort").inputValue(),
    "high",
  );
  await page
    .locator("#explorer-instructions")
    .fill('<img src=x onerror="window.injected=true">Use tests first.');
  // A key-status refresh must preserve pending human edits.
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "settings", togetherReady: false },
      }),
    ),
  );
  assert.match(
    await page.locator("#explorer-instructions").inputValue(),
    /Use tests first/,
  );
  await page.locator('[data-agent="deep_research"] summary').click();
  await page.locator("#deep_research-enabled").uncheck();
  await page.locator("#save").click();
  const saved = await page.evaluate(() => window.messages.at(-1));
  assert.equal(saved.type, "save");
  assert.equal(saved.agents.deep_research.enabled, false);
  assert.equal(saved.agents.explorer.model, models[0]);
  assert.match(saved.agents.explorer.instructions, /Use tests first/);
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "error", text: "Invalid configuration" },
      }),
    ),
  );
  assert.equal(await page.locator("#save").isEnabled(), true);
  await page.locator("#generalTab").click();
  await page.locator("#keys").click();
  assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
    type: "configureKeys",
  });
  await page.locator("#agentsTab").click();
  assert.match(
    await page.locator("#explorer-instructions").inputValue(),
    /Use tests first/,
  );
  await page.locator("#add").click();
  assert.equal(await page.locator(".profile").count(), 3);
  const custom = page.locator(".profile").last();
  await custom.locator('input[id$="-name"]').fill("API critic");
  await custom
    .locator('textarea[id$="-description"]')
    .fill("Use when reviewing API compatibility");
  await custom.locator('select[id$="-mode"]').selectOption("background");
  await page.locator("#save").click();
  const created = await page.evaluate(() => window.messages.at(-1));
  assert.equal(Object.keys(created.agents).length, 3);
  assert.equal(Object.values(created.agents).at(-1).name, "API critic");
  assert.equal(Object.values(created.agents).at(-1).mode, "background");
  await custom.getByRole("button", { name: "Delete", exact: true }).click();
  assert.equal(await page.locator(".profile").count(), 2);
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "saved", text: "Saved." } }),
    ),
  );
  await page.locator("#explorer-tool-read_file").check();
  await page.locator("#explorer-workspace").selectOption("isolated-worktree");
  await page.locator("#explorer-tool-apply_patch").check();
  await page.locator("#save").click();
  assert.deepEqual(
    (await page.evaluate(() => window.messages.at(-1))).agents.explorer.tools,
    ["read_file", "apply_patch"],
  );
  await page.locator("#toolsTab").click();
  assert.equal(await page.locator("#profiles").isVisible(), false);
  await page.locator("#main-apply_patch").check();
  await page.locator("#savePolicy").click();
  assert.deepEqual(
    (await page.evaluate(() => window.messages.at(-1))).mainTools,
    ["read_file", "apply_patch"],
  );
  await page.locator("#newTool").click();
  await page.locator("#saveTool").click();
  const toolSave = await page.evaluate(() => window.messages.at(-1));
  assert.equal(toolSave.type, "saveTool");
  assert.equal(JSON.parse(toolSave.definition).runtime.protocol, "json-stdio");
  const toolDraft = await page.locator("#toolDefinition").inputValue();
  await page.locator("#generalTab").click();
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "general", theme: "dark" } }),
    ),
  );
  await page.locator("#toolsTab").click();
  assert.equal(await page.locator("#toolDefinition").inputValue(), toolDraft);
  await page.locator("#agentsTab").click();
  assert.match(
    await page.locator("#explorer-instructions").inputValue(),
    /Use tests first/,
  );
  // Visual checks use actual page/assets at both desktop and narrow widths.
  await page.evaluate(
    (data) => window.dispatchEvent(new MessageEvent("message", { data })),
    {
      type: "settings",
      agents,
      models,
      togetherReady: true,
      builtin: ["read_file", "apply_patch"],
      tools: {},
      policy: { mainTools: ["read_file"], disabled: [] },
      revision: "fixture",
    },
  );
  await page.evaluate(() => {
    document.getElementById("status").textContent = "";
  });
  await mkdir("artifacts/agent-settings", { recursive: true });
  for (const theme of ["light", "dark"]) {
    const palette = JSON.parse(
      await readFile(`extension/media/zen-${theme}.json`, "utf8"),
    );
    await page.evaluate(
      ({ colors, theme }) => {
        for (const [key, value] of Object.entries(colors))
          document.documentElement.style.setProperty(
            "--vscode-" + key.replaceAll(".", "-"),
            value,
          );
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "general",
              theme,
              inlineMode: "manual",
              shareContext: true,
              followPair: true,
              indexEnabled: true,
              contextFile: "src/main.py",
            },
          }),
        );
      },
      { colors: palette.colors, theme },
    );
    for (const section of ["general", "agents", "tools"]) {
      await page.locator(`#${section}Tab`).click();
      await page.screenshot({
        path: `artifacts/agent-settings/${section}-${theme}.png`,
        fullPage: true,
      });
    }
  }
  for (const width of [380, 600, 800]) {
    await page.setViewportSize({ width, height: 900 });
    for (const section of ["general", "agents", "tools"]) {
      await page.locator(`#${section}Tab`).click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
        `${section} fits ${width}px viewport`,
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "Zen Settings passed: General preferences/actions, index progress/errors, draft-preserving navigation, actual light/dark assets, profile edits, disabled agents, key-only refresh, safe instruction rendering and narrow layout. Simulated host; no native editor or model calls.",
  );
} finally {
  await browser.close();
}
