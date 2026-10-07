import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(
  readFileSync(path.join(root, "upstream.lock.json"), "utf8"),
);
if (`${process.platform}-${process.arch}` !== lock.platform)
  throw new Error("This first foundation targets macOS Apple Silicon.");
mkdirSync(path.join(root, ".runtime"), { recursive: true });
const archive = path.join(root, ".runtime/codium.zip");
if (!existsSync(path.join(root, ".runtime/VSCodium.app"))) {
  execFileSync("curl", ["-fL", lock.runtime, "-o", archive], {
    stdio: "inherit",
  });
  execFileSync("ditto", ["-x", "-k", archive, path.join(root, ".runtime")], {
    stdio: "inherit",
  });
}
if (!existsSync(path.join(root, ".upstream/code-oss/.git"))) {
  mkdirSync(path.join(root, ".upstream"), { recursive: true });
  execFileSync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      lock.ref,
      lock.source,
      path.join(root, ".upstream/code-oss"),
    ],
    { stdio: "inherit", env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } },
  );
}
execFileSync(process.execPath, [path.join(root, "scripts/patch-runtime.mjs")], {
  stdio: "inherit",
});
execFileSync(
  process.execPath,
  [path.join(root, "scripts/install-tooling.mjs")],
  { stdio: "inherit" },
);
console.log("Ready. Run npm start.");
