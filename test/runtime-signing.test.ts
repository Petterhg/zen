import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("runtime signing preserves valid builds and verifies changed builds after signing", () => {
  const directory = mkdtempSync(join(tmpdir(), "zen-signing-"));
  const moduleUrl = new URL("../scripts/runtime-signing.mjs", import.meta.url)
    .href;
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { ensureRuntimeSignature } from ${JSON.stringify(moduleUrl)};
      const calls = [];
      let valid = true;
      const run = (_, args) => {
        calls.push(args);
        if (args[0] === '--verify' && !valid) throw new Error('modified');
        if (args[0] === '--force') valid = true;
      };
      const app = process.argv[1];
      const unchanged = ensureRuntimeSignature(app, { run, identity: '' });
      valid = false;
      const changed = ensureRuntimeSignature(app, { run, identity: '' });
      const restart = ensureRuntimeSignature(app, { run, identity: '' });
      const certificate = ensureRuntimeSignature(app, { run, identity: 'Test Certificate' });
      const signedRestart = ensureRuntimeSignature(app, { run, identity: 'Test Certificate' });
      console.log(JSON.stringify({ unchanged, changed, restart, certificate, signedRestart, calls }));
    `,
        join(directory, "Zen.app"),
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    assert.equal(result.unchanged, false);
    assert.equal(result.changed, true);
    assert.equal(result.restart, false);
    assert.equal(result.certificate, true);
    assert.equal(result.signedRestart, false);
    assert.equal(
      result.calls.filter((args: string[]) => args[0] === "--force").length,
      2,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
