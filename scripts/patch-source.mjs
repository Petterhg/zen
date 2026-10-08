import { patchSourceLayout } from "./native-layout.mjs";
import { applyNativeShell } from "./native-shell.mjs";
import { readFileSync, writeFileSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, ".upstream/code-oss");
const lock = JSON.parse(
  readFileSync(path.join(root, "upstream.lock.json"), "utf8"),
);
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
}).trim();
if (head !== lock.commit)
  throw new Error("Source checkout does not match upstream.lock.json.");
function patch(relative, before, after, marker) {
  const file = path.join(source, relative);
  const text = readFileSync(file, "utf8");
  if (text.includes(marker)) return;
  if (text.split(before).length !== 2)
    throw new Error(`Source patch no longer matches: ${relative}`);
  writeFileSync(file, text.replace(before, after));
}
patch(
  "src/vs/workbench/contrib/webview/browser/webviewElement.ts",
  "const allowRules = ['cross-origin-isolated', 'autoplay', 'local-network-access'];",
  "const allowRules = ['cross-origin-isolated', 'autoplay', 'local-network-access'];\n\t\tif (this.extension?.id.value === 'pair-code.pair-code') {\n\t\t\tallowRules.push('microphone');\n\t\t}",
  "this.extension?.id.value === 'pair-code.pair-code'",
);
patch(
  "src/vs/workbench/contrib/webview/browser/pre/index.html",
  "const allowRules = ['cross-origin-isolated;', 'autoplay;', 'local-network-access;'];",
  "const allowRules = ['cross-origin-isolated;', 'autoplay;', 'local-network-access;'];\n\t\t\t\tif (searchParams.get('extensionId') === 'pair-code.pair-code') {\n\t\t\t\t\tallowRules.push('microphone;');\n\t\t\t\t}",
  "searchParams.get('extensionId') === 'pair-code.pair-code'",
);
patch(
  "src/vs/code/electron-main/app.ts",
  "\t\tconst alwaysAllowedPermissions = new Set(['pointerLock', 'notifications']);",
  `\t\t/** Grants microphone access only to the Pair Code webview's actual frame ancestry. */
\t\tconst isPairCodeAudioFrame = (webContents: Electron.WebContents | null, requestingUrl: string | undefined): boolean => {
\t\t\tif (!webContents || !requestingUrl?.startsWith('vscode-webview://')) {
\t\t\t\treturn false;
\t\t\t}
\t\t\ttry {
\t\t\t\tlet frame = webContents.mainFrame.framesInSubtree.find(candidate => candidate.url === requestingUrl);
\t\t\t\twhile (frame) {
\t\t\t\t\tconst url = new URL(frame.url);
\t\t\t\t\tif (url.protocol === 'vscode-webview:' && url.searchParams.get('extensionId') === 'pair-code.pair-code') {
\t\t\t\t\t\treturn true;
\t\t\t\t\t}
\t\t\t\t\tframe = frame.parent ?? undefined;
\t\t\t\t}
\t\t\t} catch {
\t\t\t\treturn false;
\t\t\t}
\t\t\treturn false;
\t\t};

\t\tconst alwaysAllowedPermissions = new Set(['pointerLock', 'notifications']);`,
  "const isPairCodeAudioFrame =",
);
patch(
  "src/vs/code/electron-main/app.ts",
  "\t\t\t\treturn callback(allowedPermissionsInWebview.has(permission));",
  "\t\t\t\tif (permission === 'media' && isPairCodeAudioFrame(webContents, details.requestingUrl)) {\n\t\t\t\t\treturn callback(details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio');\n\t\t\t\t}\n\t\t\t\treturn callback(allowedPermissionsInWebview.has(permission));",
  "details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'",
);
patch(
  "src/vs/code/electron-main/app.ts",
  "\t\t\t\treturn allowedPermissionsInWebview.has(permission);",
  "\t\t\t\tif (permission === 'media' && details.mediaType === 'audio' && isPairCodeAudioFrame(webContents, details.requestingUrl)) {\n\t\t\t\t\treturn true;\n\t\t\t\t}\n\t\t\t\treturn allowedPermissionsInWebview.has(permission);",
  "details.mediaType === 'audio' && isPairCodeAudioFrame",
);
const preFile = path.join(
  source,
  "src/vs/workbench/contrib/webview/browser/pre/index.html",
);
const preContent = readFileSync(preFile, "utf8");
const inlineScript = /<script[^>]*>([\s\S]*?)<\/script>/.exec(preContent)?.[1];
if (!inlineScript) throw new Error("Cannot find the webview bootstrap script.");
const scriptHash = createHash("sha256").update(inlineScript).digest("base64");
writeFileSync(
  preFile,
  preContent.replace(
    /script-src 'sha256-[^']+'/,
    `script-src 'sha256-${scriptHash}'`,
  ),
);
patchSourceLayout(source);
applyNativeShell(path.join(source, "src/vs/workbench/browser/media/style.css"));
const productPath = path.join(source, "product.json");
const product = JSON.parse(readFileSync(productPath, "utf8"));
Object.assign(product, {
  nameShort: "Zen",
  nameLong: "Zen",
  applicationName: "pair-code",
  dataFolderName: ".pair-code",
  sharedDataFolderName: ".pair-code-shared",
  urlProtocol: "pair-code",
  darwinBundleIdentifier: "dev.paircode.editor",
});
writeFileSync(productPath, JSON.stringify(product, null, "\t") + "\n");
cpSync(
  path.join(root, "extension"),
  path.join(source, "extensions/pair-code"),
  { recursive: true },
);
console.log(
  "Source fork patched, including built-in pairing extension. See docs/architecture.md for the full source-build path.",
);
