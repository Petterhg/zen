import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(
    '<main class="monaco-workbench"><div class="editor"></div><div class="panel"></div><div id="title"></div></main>',
  );
  await page.addScriptTag({
    content: (
      await transform(
        (await readFile("scripts/native-layout.ts", "utf8")).replaceAll(
          "export function",
          "function",
        ),
        { loader: "ts" },
      )
    ).code,
  });
  const result = await page.evaluate(async () => {
    const values = {
      "zen.available": true,
      "zen.voiceState": "disconnected",
      "zen.assistanceLevel": 25,
    };
    const commands = [];
    let listener;
    let bottom = true;
    const disposables = [];
    const context = {
      getContextKeyValue: (key) => values[key],
      onDidChangeContext: (fn) => {
        listener = fn;
        return {
          dispose() {
            listener = undefined;
          },
        };
      },
    };
    const part = (selector) => ({
      getContainer: () => document.querySelector(selector),
      contextKeyService: context,
      layoutService: { isVisible: () => bottom, getPanelPosition: () => 2 },
      instantiationService: {
        invokeFunction: (fn) =>
          fn({
            get: () => ({ executeCommand: async (id) => commands.push(id) }),
          }),
      },
      _register: (d) => disposables.push(d),
    });
    const editor = part(".editor"),
      panel = part(".panel");
    const sizes = [
      zenLayoutPart(editor, 900, 600, "commands"),
      zenLayoutPart(panel, 900, 210, "commands"),
    ];
    const strip = document.querySelector(".zen-pairing-strip");
    const initialParent = strip.parentElement.className;
    strip.querySelector("button").click();
    values["zen.voiceState"] = "listening";
    listener();
    strip.querySelector("button").click();
    values["zen.voiceState"] = "muted";
    listener();
    const muted = strip.querySelector("button").textContent;
    strip.querySelectorAll("button")[1].click();
    values["zen.assistanceLevel"] = 0;
    listener();
    const label = strip.querySelectorAll("button")[3].textContent;
    bottom = false;
    sizes.push(zenLayoutPart(editor, 360, 500, "commands"));
    const folded = {
      parent: strip.parentElement.className,
      count: document.querySelectorAll(".zen-pairing-strip").length,
      compact: strip.classList.contains("compact"),
    };
    values["zen.available"] = false;
    listener();
    const disabled = strip.querySelector("button").disabled;
    const group = {
      element: document.createElement("div"),
      titleContainer: document.createElement("div"),
      editorContainer: document.createElement("div"),
      activeEditor: {
        getName: () => "<unsafe>.ts",
        getDescription: () => "/sample",
      },
      _register: (d) => disposables.push(d),
    };
    group.element.append(group.titleContainer, group.editorContainer);
    document.body.append(group.element);
    zenLayoutGroup(group, 900, 600);
    group.activeEditor = {
      getName: () => "next.ts",
      getDescription: () => "/next",
    };
    group.titleContainer.textContent = "next tab";
    await new Promise((resolve) => setTimeout(resolve, 0));
    const heading = group.element.querySelector("h2").textContent;
    disposables.forEach((d) => d.dispose());
    return {
      sizes,
      initialParent,
      commands,
      muted,
      label,
      folded,
      disabled,
      heading,
      remaining: document.querySelectorAll(".zen-pairing-strip").length,
    };
  });
  assert.deepEqual(result, {
    sizes: [600, 166, 456],
    initialParent: "panel",
    commands: [
      "pairCode.startVoice",
      "pairCode.toggleVoiceMute",
      "pairCode.endVoice",
    ],
    muted: "Unmute",
    label: "Voice only ▾",
    folded: { parent: "editor", count: 1, compact: true },
    disabled: true,
    heading: "next.ts",
    remaining: 0,
  });
  console.log(
    "Native helper tests passed: reserved geometry, fold/resize, voice state, command routing, heading refresh, disposal. Browser fixture, not native app proof.",
  );
} finally {
  await browser.close();
}
