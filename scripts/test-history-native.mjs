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
import { requestBackend, DEFAULT_MODELS } from ${JSON.stringify(path.join(root, "extension/src/backend.ts"))};
import { createProposal } from ${JSON.stringify(path.join(root, "extension/src/core.ts"))};
import { EditorHistory } from ${JSON.stringify(path.join(root, "extension/src/history/editor.ts"))};
import { Automation } from ${JSON.stringify(path.join(root, "extension/src/automation.ts"))};
import { Definitions } from ${JSON.stringify(path.join(root, "extension/src/definitions.ts"))};
import { DEFAULT_AGENTS } from ${JSON.stringify(path.join(root, "extension/src/subagents.ts"))};
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
    const fragment = { type: "session.input_transcript.delta", event_id: "synthetic-fragment", delta: "fixture voice instruction", start_ms: 10, end_ms: 30 };
    recorder.conversation(doc.uri.toString(), 1, fragment);
    recorder.conversation(doc.uri.toString(), 1, fragment);
    await recorder.flush();
    const captured = { uri: doc.uri.toString(), file: doc.uri.fsPath, language: doc.languageId, version: doc.version, text: doc.getText(), selection: "", selectionStart: 0, selectionEnd: 0, diagnostics: [] };
    const generated = { status: "proposal", summary: "Synthetic test change", edits: [{ oldText: "1", newText: "2" }] };
    let attempts = 0;
    const result = await requestBackend({ provider: "cerebras", model: DEFAULT_MODELS.cerebras, apiKey: "synthetic-native-secret", history: [{ role: "user", text: "Use two instead" }], context: captured, assistanceLevel: 100, signal: new AbortController().signal, onEvidence: event => recorder.provider(requestId, event), fetchImpl: async () => { attempts++; return Response.json({ choices: [{ finish_reason: attempts === 1 ? "length" : "stop", message: { content: attempts === 1 ? "partial" : JSON.stringify(generated), reasoning: "synthetic private reasoning" } }] }); } });
    await recorder.result(requestId, result);
    const proposal = createProposal(captured, result);
    assert.ok(proposal);
    const start = proposal.start;
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
    const invocations = report.records.filter(r => r.type === "provider.request");
    assert.equal(invocations.length, 2);
    assert.equal(invocations[1].data.retryOf, invocations[0].data.invocationId);
    const created = report.records.find(r => r.type === "proposal.created");
    assert.deepEqual(created.data.invocationIds, invocations.map(r => r.data.invocationId));
    assert.equal(report.records.filter(r => r.type === "voice.transcript.fragment").length, 1);
    for (const r of report.records.filter(r => r.type.startsWith("provider.") || r.type === "backend.result" || r.type === "voice.transcript.fragment")) assert.equal(typeof r.data.body, "string");
    assert.equal(JSON.stringify(report).includes("fixture voice instruction"), false);
    assert.equal(JSON.stringify(report).includes("synthetic private reasoning"), false);
    assert.ok(report.records.some(r => r.type === "document.saved" && r.data.version === accepted.data.version));
    assert.ok(report.files[0].spans.some(s => s.origin.writer === "ai" && s.origin.requestId === requestId));
    editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(doc.positionAt(start), doc.positionAt(start+1));
    await recorder.why();
    const whyDocument = vscode.workspace.textDocuments.find(d => d.uri.scheme === "zen-history" && d.uri.path === "/why.md");
    assert.ok(whyDocument);
    const whyText = whyDocument.getText();
    assert.ok(whyText.includes("Accepted AI proposal"));
    assert.ok(whyText.includes("Use two instead"));
    assert.ok(whyText.includes("Synthetic test change"));
    assert.ok(whyText.includes("retry"));
    assert.equal(whyText.includes("fixture voice instruction"), false);
    editor = await vscode.window.showTextDocument(doc);
    assert.equal(await editor.edit(builder => builder.insert(doc.positionAt(doc.getText().length), "// later")), true);
    assert.ok(doc.getText().includes("// later"));
    const clearingDeadline = Date.now() + 3000;
    let currentWhy = await vscode.workspace.openTextDocument(whyDocument.uri);
    while (Date.now() < clearingDeadline && !currentWhy.getText().includes("cleared")) {
      await new Promise(resolve => setTimeout(resolve, 50));
      currentWhy = await vscode.workspace.openTextDocument(whyDocument.uri);
    }
    diagnostic = { report, currentWhy: currentWhy.getText(), isClosed: currentWhy.isClosed, contents: [...recorder.inspections], sourceText: doc.getText() };
    assert.ok(currentWhy.getText().includes("cleared"));
    const workers = recorder.workers(requestId);
    await workers.started("worker-fixture", "implementer", DEFAULT_AGENTS.explorer, "Update both files", "background", "repo");
    await workers.provider("worker-fixture", { type: "provider.request", invocationId: "worker-attempt", provider: "together", model: "synthetic-worker", phase: "tools", effectiveEffort: "high", retry: false, body: { messages: [] } });
    const secondUri = vscode.Uri.file(${JSON.stringify(path.join(workspace, "second.ts"))});
    await writeFile(secondUri.fsPath, "export const second = 1;\\n");
    const secondDoc = await vscode.workspace.openTextDocument(secondUri);
    await recorder.flush();
    const changes = recorder.changes();
    const automation = new Automation(new Definitions(${JSON.stringify(path.join(temporary, "definitions"))}), ${JSON.stringify(path.join(temporary, "tasks"))}, () => true, () => 100, () => {}, changes);
    const change = { id: "worker-changes", root: ${JSON.stringify(workspace)}, status: "pending", files: [
      { path: "sample.ts", before: doc.getText(), after: doc.getText() + "// worker change\\n", version: doc.version },
      { path: "second.ts", before: secondDoc.getText(), after: "export const second = 2;\\n", version: secondDoc.version }
    ] };
    await changes.proposed(change, "worker-fixture");
    await automation.accept(change);
    assert.equal(change.status, "accepted");
    await workers.finished("worker-fixture", { summary: "Updated both files" }, change.id);
    await recorder.inspect();
    const workerReport = JSON.parse(vscode.window.activeTextEditor.document.getText());
    const started = workerReport.records.find(r => r.type === "worker.started");
    const acceptedWorker = workerReport.records.filter(r => r.type === "worker.change-accepted");
    assert.equal(started.data.parentRequestId, requestId);
    assert.equal(acceptedWorker.length, 2);
    assert.ok(acceptedWorker.every(r => r.data.requestId === started.data.requestId && r.data.runId === "worker-fixture"));
    assert.ok(acceptedWorker.every(r => typeof r.data.body === "string"));
    const secondProjection = workerReport.files.find(f => f.file === secondUri.fsPath);
    assert.ok(secondProjection.spans.some(s => s.origin.runId === "worker-fixture" && s.start === secondDoc.getText().indexOf("2")));
    const preserved = workerReport.files.find(f => f.file === doc.uri.fsPath);
    assert.ok(preserved.spans.some(s => s.origin.proposalId === created.data.proposalId));
    let targetEditor = await vscode.window.showTextDocument(secondDoc);
    const numberOffset = secondDoc.getText().indexOf("2");
    targetEditor.selection = new vscode.Selection(secondDoc.positionAt(numberOffset), secondDoc.positionAt(numberOffset+1));
    await recorder.why();
    let workerWhy = await vscode.workspace.openTextDocument(recorder.inspectionUri);
    assert.ok(workerWhy.getText().includes("Update both files"));
    assert.ok(workerWhy.getText().includes("Use two instead"));
    assert.ok(workerWhy.getText().includes("synthetic"));
    await writeFile(${JSON.stringify(path.join(workspace, ".pairignore"))}, "sample.ts\\n");
    targetEditor = await vscode.window.showTextDocument(secondDoc);
    targetEditor.selection = new vscode.Selection(secondDoc.positionAt(numberOffset), secondDoc.positionAt(numberOffset+1));
    await recorder.why();
    workerWhy = await vscode.workspace.openTextDocument(recorder.inspectionUri);
    assert.equal(workerWhy.getText().includes("Update both files"), false);
    assert.equal(workerWhy.getText().includes("Use two instead"), false);
    assert.equal(workerWhy.getText().includes("synthetic"), false);
    await vscode.workspace.fs.delete(vscode.Uri.file(${JSON.stringify(path.join(workspace, ".pairignore"))}));
    const stale = { ...change, id: "stale-worker", status: "pending", files: change.files.map(f => ({ ...f })) };
    const beforeSecond = secondDoc.getText();
    await assert.rejects(automation.accept(stale), /changed since/);
    assert.equal(secondDoc.getText(), beforeSecond);
    const rejectedChange = { ...change, id: "rejected-worker", status: "pending", files: [
      { path: "sample.ts", before: doc.getText(), after: doc.getText() + "// rejected", version: doc.version },
      { path: "second.ts", before: secondDoc.getText(), after: secondDoc.getText() + "// rejected", version: secondDoc.version }
    ] };
    await changes.proposed(rejectedChange, "worker-fixture");
    await changes.rejected(rejectedChange);
    assert.equal(secondDoc.getText(), beforeSecond);
    await recorder.inspect();
    const rejectedReport = JSON.parse(vscode.window.activeTextEditor.document.getText());
    assert.equal(rejectedReport.records.filter(r => r.type === "worker.change-rejected").length, 2);
    assert.equal(rejectedReport.records.filter(r => r.type === "worker.change-accepted").length, 2);
    automation.dispose();
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
    await writeFile(${JSON.stringify(path.join(temporary, "result.json"))}, JSON.stringify({ passed: true, checks: ["native typing origin", "accepted proposal/request", "saved state", "range attribution", "restart recovery", "ignore revocation", "provider retry/proposal chain", "deduplicated voice fragments", "withheld multi-file bodies", "selection why inspector", "stale inspection clearing", "worker parent and multi-file acceptance", "worker stale refusal and rejection records", "worker range and parent inspector", "cross-file anchor revocation"], records: report.records.length }));
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
