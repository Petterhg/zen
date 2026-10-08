import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Never downgrade encryption or loosen Keychain access requirements. An unchanged
// app keeps its existing signature; changed builds need a consistent certificate
// to preserve their macOS identity across releases.
export function ensureRuntimeSignature(
  app,
  { identity = process.env.ZEN_CODESIGN_IDENTITY, run = execFileSync } = {},
) {
  const stamp = path.join(path.dirname(app), "signing-identity");
  let valid = false;
  try {
    run("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
    valid = true;
  } catch {
    /* Changed bundle: sign below, then verify. */
  }
  const previous = existsSync(stamp)
    ? readFileSync(stamp, "utf8").trim()
    : undefined;
  if (valid && (!identity || previous === identity)) {
    console.log(
      "Existing app signature is valid; keeping its Keychain identity.",
    );
    return false;
  }
  run("codesign", ["--force", "--deep", "--sign", identity || "-", app], {
    stdio: "inherit",
  });
  run("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
  writeFileSync(stamp, identity || "-");
  console.log(
    identity
      ? "Signed with configured macOS identity."
      : "Updated development signature. Changed ad-hoc builds may require Keychain authorization again.",
  );
  return true;
}
