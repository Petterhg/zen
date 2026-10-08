import { ensureRuntimeSignature } from "./runtime-signing.mjs";
import { applyRuntimeShell } from "./native-shell.mjs";
import { existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  appearanceDefaults,
  applyAppearanceDefaults,
} from "./appearance-defaults.mjs";
import { applyPythonDefaults } from "./python-defaults.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const executable = path.join(
  root,
  ".runtime/VSCodium.app/Contents/MacOS/VSCodium",
);
if (!existsSync(executable)) throw new Error("Run npm run bootstrap first.");
execFileSync(process.execPath, [path.join(root, "scripts/build.mjs")], {
  cwd: root,
  stdio: "inherit",
});
const userData = path.join(root, ".runtime/user-data");
mkdirSync(path.join(userData, "User"), { recursive: true });
const settingsFile = path.join(userData, "User/settings.json");
if (!existsSync(settingsFile))
  writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        ...appearanceDefaults,
        "editor.formatOnSave": true,
        "editor.defaultFormatter": "esbenp.prettier-vscode",
        "[typescript]": { "editor.defaultFormatter": "esbenp.prettier-vscode" },
        "[javascript]": { "editor.defaultFormatter": "esbenp.prettier-vscode" },
        "eslint.useFlatConfig": true,
        "breadcrumbs.enabled": false,
        "telemetry.telemetryLevel": "off",
        "chat.disableAIFeatures": true,
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "security.workspace.trust.enabled": true,
        "pairCode.backend": "groq",
      },
      null,
      2,
    ),
  );
applyAppearanceDefaults(settingsFile);
applyPythonDefaults(settingsFile);
mkdirSync(path.join(root, ".runtime/extensions"), { recursive: true });
// Extension development hosts have no persistent working-copy backup path.
// Install this local prototype normally so unsaved buffers survive reloads.
const extension = path.join(root, "extension");
const installed = path.join(
  root,
  ".runtime/VSCodium.app/Contents/Resources/app/extensions/pair-code",
);
mkdirSync(installed, { recursive: true });
for (const file of ["package.json", "dist", "media"])
  cpSync(path.join(extension, file), path.join(installed, file), {
    recursive: true,
  });
applyRuntimeShell(
  path.join(root, ".runtime/VSCodium.app/Contents/Resources/app"),
);
if (process.platform === "darwin")
  ensureRuntimeSignature(path.join(root, ".runtime/VSCodium.app"));
const args = [
  "--new-window",
  "--user-data-dir",
  userData,
  "--extensions-dir",
  path.join(root, ".runtime/extensions"),
  "--shared-data-dir",
  path.join(root, ".runtime/shared-data"),
  "--enable-proposed-api=pair-code.pair-code",
  ...process.argv.slice(2).filter((arg) => !arg.startsWith("--inspect-")),
];
if (!process.argv.slice(2).some((arg) => !arg.startsWith("--")))
  args.push(
    path.join(root, "demo"),
    "--goto",
    path.join(root, "demo/pairing.ts"),
  );
const child = spawn(executable, args, {
  cwd: root,
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    PAIR_CODE_PROJECT_ROOT: root,
    ELECTRON_RUN_AS_NODE: undefined,
  },
});
child.unref();
console.log(`Zen opened (process ${child.pid}). Project: ${root}`);
