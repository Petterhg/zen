import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { applyPythonDefaults } from "./python-defaults.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(
  readFileSync(path.join(root, "upstream.lock.json"), "utf8"),
);
const cli = path.join(
  root,
  ".runtime/VSCodium.app/Contents/Resources/app/bin/codium",
);
mkdirSync(path.join(root, ".cache/tooling"), { recursive: true });
for (const tool of lock.tooling) {
  const archive = path.join(
    root,
    `.cache/tooling/${tool.id}-${tool.version}.vsix`,
  );
  if (!existsSync(archive))
    execFileSync("curl", ["-fL", tool.url, "-o", archive], {
      stdio: "inherit",
    });
  execFileSync(
    cli,
    [
      "--user-data-dir",
      path.join(root, ".runtime/user-data"),
      "--extensions-dir",
      path.join(root, ".runtime/extensions"),
      "--install-extension",
      archive,
      "--force",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    },
  );
}

applyPythonDefaults(path.join(root, ".runtime/user-data/User/settings.json"));
