import { ensureRuntimeSignature } from "./runtime-signing.mjs";
import { applyRuntimeShell } from "./native-shell.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const app = path.join(root, ".runtime/VSCodium.app");
const resources = path.join(app, "Contents/Resources/app");
function replaceOnce(file, original, replacement, marker) {
  const content = readFileSync(file, "utf8");
  if (content.includes(marker)) return;
  if (content.split(original).length !== 2)
    throw new Error(`Upstream changed: cannot safely patch ${file}`);
  writeFileSync(file, content.replace(original, replacement));
}
// Grant the outer frame policy only to our extension, preserving all other webviews.
replaceOnce(
  path.join(resources, "out/vs/workbench/workbench.desktop.main.js"),
  "_initElement(e,t,s,n){const o=",
  '_initElement(e,t,s,n){if(t?.id.value==="pair-code.pair-code"){this.element.setAttribute("allow",this.element.getAttribute("allow")+"; microphone")}const o=',
  't?.id.value==="pair-code.pair-code"',
);
const pre = path.join(
  resources,
  "out/vs/workbench/contrib/webview/browser/pre/index.html",
);
replaceOnce(
  pre,
  "const allowRules = ['cross-origin-isolated;', 'autoplay;', 'local-network-access;'];",
  "const allowRules = ['cross-origin-isolated;', 'autoplay;', 'local-network-access;'];\n\t\t\t\tif (searchParams.get('extensionId') === 'pair-code.pair-code') { allowRules.push('microphone;'); }",
  "searchParams.get('extensionId') === 'pair-code.pair-code'",
);
// Electron permission checks inspect the actual frame ancestry rather than trusting UI messages.
const helper =
  'const pairCodeAudioFrame=(_webContents,_details)=>{try{if(!_webContents||!_details.requestingUrl?.startsWith("vscode-webview://"))return false;const _frames=_webContents.mainFrame.framesInSubtree;let _frame=_frames.find(_f=>_f.url===_details.requestingUrl);while(_frame){const _url=new URL(_frame.url);if(_url.protocol==="vscode-webview:"&&_url.searchParams.get("extensionId")==="pair-code.pair-code")return true;_frame=_frame.parent}return false}catch{return false}};';
const original =
  "Eo.defaultSession.setPermissionRequestHandler((_,y,S,C)=>i(C.requestingUrl)?S(o.has(y)):r(_,C.requestingUrl,C.isMainFrame)?S(a.has(y)):S(!1)),Eo.defaultSession.setPermissionCheckHandler((_,y,S,C)=>i(C.requestingUrl)?o.has(y):r(_,C.requestingUrl,C.isMainFrame)?a.has(y):!1);";
const replacement =
  helper +
  'Eo.defaultSession.setPermissionRequestHandler((_,y,S,C)=>y==="media"&&pairCodeAudioFrame(_,C)?S(Array.isArray(C.mediaTypes)&&C.mediaTypes.length===1&&C.mediaTypes[0]==="audio"):i(C.requestingUrl)?S(o.has(y)):r(_,C.requestingUrl,C.isMainFrame)?S(a.has(y)):S(!1)),Eo.defaultSession.setPermissionCheckHandler((_,y,S,C)=>y==="media"&&C.mediaType==="audio"&&pairCodeAudioFrame(_,C)?true:i(C.requestingUrl)?o.has(y):r(_,C.requestingUrl,C.isMainFrame)?a.has(y):!1);';
replaceOnce(
  path.join(resources, "out/main.js"),
  original,
  replacement,
  "const pairCodeAudioFrame=",
);
// Updating the inline webview script requires regenerating its exact CSP hash.
const preContent = readFileSync(pre, "utf8");
const inlineScript = /<script[^>]*>([\s\S]*?)<\/script>/.exec(preContent)?.[1];
if (!inlineScript) throw new Error("Cannot find the webview bootstrap script.");
const scriptHash = createHash("sha256").update(inlineScript).digest("base64");
writeFileSync(
  pre,
  preContent.replace(
    /script-src 'sha256-[^']+'/,
    `script-src 'sha256-${scriptHash}'`,
  ),
);
const productPath = path.join(resources, "product.json");
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
for (const relative of Object.keys(product.checksums ?? {})) {
  product.checksums[relative] = createHash("sha256")
    .update(readFileSync(path.join(resources, "out", relative)))
    .digest("base64")
    .replace(/=+$/, "");
}
writeFileSync(productPath, JSON.stringify(product, null, 2));
applyRuntimeShell(resources);
const plist = path.join(app, "Contents/Info.plist");
for (const [key, value] of Object.entries({
  CFBundleDisplayName: "Zen",
  CFBundleName: "Zen",
  CFBundleIdentifier: "dev.paircode.editor",
  NSMicrophoneUsageDescription:
    "Pair Code uses your microphone during a voice pairing session.",
})) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :${key} ${value}`,
      plist,
    ]);
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Add :${key} string ${value}`,
      plist,
    ]);
  }
}
// This is a local development application, not a notarized distributable.
if (existsSync(app)) ensureRuntimeSignature(app);
console.log(
  "Patched isolated runtime: Zen branding and audio-only access for the pairing panel.",
);
