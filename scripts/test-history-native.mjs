import { chromium } from "playwright";
import { createServer } from "node:net";
import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await realpath(
  await mkdtemp("/private/tmp/zen-history-native-"),
);
const fixture = path.join(temporary, "extension"),
  workspace = path.join(temporary, "repo");
await mkdir(fixture);
await mkdir(workspace);
execFileSync("git", ["init", "-q", workspace]);
await writeFile(path.join(workspace, "sample.ts"), "const value = 1;\n");
await mkdir(path.join(temporary, "profile/User"), { recursive: true });
await writeFile(
  path.join(temporary, "profile/User/settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "pairCode.memory.enabled": false,
    "pairCode.index.enabled": false,
    "editor.formatOnSave": false,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
  }),
);
await writeFile(
  path.join(fixture, "package.json"),
  JSON.stringify({
    name: "history-fixture",
    publisher: "zen",
    version: "1.0.0",
    engines: { vscode: "^1.100.0" },
    main: "index.cjs",
    activationEvents: ["onStartupFinished"],
    enabledApiProposals: ["textDocumentChangeReason"],
  }),
);
const source = `
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { EditorHistory } from ${JSON.stringify(path.join(root, "extension/src/history/editor.ts"))};
export async function activate(context) {
  let recorder;
  let diagnostic;
  try {
    // Synthetic-only vault: verifies adapter/engine, not OS Keychain integration.
    const keys = new Map();
    const fixtureContext = { globalState: context.globalState, globalStorageUri: context.globalStorageUri, secrets: { get: async k => keys.get(k), store: async (k,v) => { keys.set(k,v); } } };
    recorder = new EditorHistory(fixtureContext);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(${JSON.stringify(path.join(workspace, "sample.ts"))}));
    let editor = await vscode.window.showTextDocument(doc);
    await recorder.initialize();
    editor.selection = new vscode.Selection(doc.positionAt(doc.getText().length), doc.positionAt(doc.getText().length));
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await writeFile(${JSON.stringify(path.join(temporary, "ready.json"))}, "ready");
    const typingDeadline = Date.now() + 15000;
    while (Date.now() < typingDeadline && !doc.getText().includes("// human")) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(doc.getText().includes("// human"), "native typing command must change the target buffer");
    await recorder.flush();
    const requestId = await recorder.request(doc.uri.toString(), "Use two instead", { provider: "synthetic", assistance: 100 });
    const start = doc.getText().indexOf("1");
    const proposal = { uri: doc.uri.toString(), version: doc.version, start, end: start + 1, oldText: "1", newText: "2", summary: "Synthetic test change" };
    await recorder.proposal(proposal, requestId);
    await recorder.prepareApply(proposal);
    await editor.edit(builder => builder.replace(new vscode.Range(doc.positionAt(start), doc.positionAt(start+1)), "2"), { undoStopBefore: true, undoStopAfter: true });
    await recorder.accepted(proposal);
    await doc.save(); await recorder.flush();
    await recorder.inspect();
    const report = JSON.parse(vscode.window.activeTextEditor.document.getText());
    diagnostic = report;
    assert.equal(report.status, "recording");
    assert.ok(report.records.some(r => r.type === "document.changed" && r.data.origin.writer === "human"));
    const accepted = report.records.find(r => r.type === "proposal.accepted");
    assert.equal(accepted.data.requestId, requestId);
    assert.ok(report.records.some(r => r.type === "document.saved" && r.data.version === accepted.data.version));
    assert.ok(report.files[0].spans.some(s => s.origin.writer === "ai" && s.origin.requestId === requestId));
    await recorder.stop(); recorder.dispose();
    recorder = new EditorHistory(fixtureContext);
    await recorder.initialize(); await recorder.inspect();
    const restarted = JSON.parse(vscode.window.activeTextEditor.document.getText());
    assert.ok(restarted.records.some(r => r.id === accepted.id));
    // Current ignore policy must also block inspection of previously captured evidence.
    await writeFile(${JSON.stringify(path.join(workspace, ".pairignore"))}, "sample.ts\\n");
    await recorder.inspect();
    const restricted = JSON.parse(vscode.window.activeTextEditor.document.getText());
    assert.equal(restricted.records.filter(r => r.data.file.endsWith("sample.ts")).length, 0);
    await writeFile(${JSON.stringify(path.join(temporary, "result.json"))}, JSON.stringify({ passed: true, checks: ["native typing origin", "accepted proposal/request", "saved state", "range attribution", "restart recovery", "ignore revocation"], records: report.records.length }));
  } catch (error) { await writeFile(${JSON.stringify(path.join(temporary, "result.json"))}, JSON.stringify({ passed: false, error: String(error), stack: error.stack, diagnostic })); }
  finally { if (recorder) { await recorder.stop(); recorder.dispose(); } }
}
`;
await build({
  stdin: {
    contents: source,
    resolveDir: root,
    sourcefile: "history-native.ts",
    loader: "ts",
  },
  outfile: path.join(fixture, "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
});
// Resolve the already installed Turso dependency, without copying or modifying the app.
await import("node:fs/promises").then(({ symlink }) =>
  symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules")),
);
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const child = spawn(
  path.join(root, ".runtime/VSCodium.app/Contents/MacOS/VSCodium"),
  [
    "--new-window",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir",
    path.join(temporary, "profile"),
    "--extensions-dir",
    path.join(temporary, "extensions"),
    `--extensionDevelopmentPath=${fixture}`,
    "--enable-proposed-api=zen.history-fixture",
    "--skip-welcome",
    "--skip-release-notes",
    workspace,
  ],
  {
    stdio: "pipe",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
  },
);
let launchLog = "";
child.stdout.on("data", (chunk) => {
  launchLog += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  launchLog += chunk.toString();
});
try {
  const deadline = Date.now() + 55000;
  let result,
    typed = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Native app exited ${child.exitCode}: ${launchLog}`);
    if (!typed) {
      let ready = false;
      try {
        await readFile(path.join(temporary, "ready.json"));
        ready = true;
      } catch {}
      if (ready) {
        const browser = await chromium.connectOverCDP(
          `http://127.0.0.1:${port}`,
        );
        try {
          const page = browser
            .contexts()[0]
            .pages()
            .find((page) => page.url().includes("workbench"));
          if (!page) throw new Error("Isolated editor renderer not found.");
          const input = page.locator(".monaco-editor .view-lines").first();
          await input.click({ position: { x: 120, y: 10 }, timeout: 5000 });
          await page.keyboard.press("Meta+End");
          await page.keyboard.type("// human");
          await page.keyboard.press("Enter");
          typed = true;
        } finally {
          await browser.close();
        }
      }
    }
    try {
      result = JSON.parse(
        await readFile(path.join(temporary, "result.json"), "utf8"),
      );
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!result)
    throw new Error(`Native history fixture timed out: ${temporary}`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(result.error);
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null)
    await new Promise((resolve) => child.once("exit", resolve));
  await rm(temporary, { recursive: true, force: true });
}
