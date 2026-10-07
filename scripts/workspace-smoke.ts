import * as vscode from "vscode";
import assert from "node:assert/strict";
import { workspaceTools } from "../extension/src/workspace-tools.js";
export async function run() {
  assert.equal(
    vscode.workspace.isTrusted,
    true,
    "The explicitly trusted demo workspace is required",
  );
  const root = vscode.workspace.workspaceFolders?.[0];
  assert.ok(
    root?.uri.fsPath.endsWith("/pair-code/demo"),
    "Only run against Pair Code demo",
  );
  const signal = AbortSignal.timeout(45000);
  const tools = workspaceTools(() => true);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool);
    return tool.execute(args, signal);
  };
  const overview = (await call("workspace_overview")) as { files: string[] };
  assert.ok(overview.files.includes("pairing.ts"));
  const read = (await call("read_file", { path: "pairing.ts" })) as {
    lines: string;
  };
  assert.match(read.lines, /export function summarize/);
  const search = (await call("search_text", { query: "summarize" })) as {
    matches: { path: string }[];
  };
  assert.ok(search.matches.some((m) => m.path === "pairing.ts"));
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(root.uri, "pairing.ts"),
  );
  await vscode.window.showTextDocument(document);
  const usage = (await call("symbol_usages", {
    path: "pairing.ts",
    line: 13,
    column: 15,
    kind: "definition",
  })) as { locations: { line: number }[] };
  assert.ok(
    usage.locations.some((l) => l.line === 3),
    "TypeScript definition resolves in the actual editor",
  );
  await call("diagnostics", { path: "pairing.ts" });
  await assert.rejects(call("read_file", { path: "../.env" }));
  const disabled = workspaceTools(() => false).find(
    (t) => t.name === "read_file",
  )!;
  await assert.rejects(disabled.execute({ path: "pairing.ts" }, signal));
  console.log(
    "Workspace smoke passed: real editor inventory, buffer read, search, TypeScript definition, diagnostics, excluded paths and sharing guard. No provider calls or file edits.",
  );
}
