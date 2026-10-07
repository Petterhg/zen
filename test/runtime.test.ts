import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";

test("microphone permission helper requires the actual Pair frame ancestry", () => {
  const source = readFileSync(
    new URL("../scripts/patch-runtime.mjs", import.meta.url),
    "utf8",
  );
  const helperLiteral =
    /const helper\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*;/.exec(
      source,
    )?.[1];
  assert.ok(helperLiteral);
  const helper = runInNewContext(helperLiteral) as string;
  const permission = runInNewContext(helper + "pairCodeAudioFrame", {
    URL,
  }) as (contents: object | null, details: object) => boolean;
  const frame = {
    url: "vscode-webview://pair/fake.html?id=1",
    parent: {
      url: "vscode-webview://pair/index.html?extensionId=pair-code.pair-code",
      parent: null,
    },
  };
  const otherFrame = {
    url: "vscode-webview://other/fake.html?id=2",
    parent: {
      url: "vscode-webview://other/index.html?extensionId=other.extension",
      parent: null,
    },
  };
  const contents = { mainFrame: { framesInSubtree: [frame, otherFrame] } };
  assert.deepEqual(
    [
      permission(contents, { requestingUrl: frame.url }),
      permission(contents, { requestingUrl: otherFrame.url }),
      permission(contents, {
        requestingUrl: "https://example.com/?extensionId=pair-code.pair-code",
      }),
      permission(contents, {
        requestingUrl: "vscode-webview://unknown/fake.html",
      }),
      permission(null, { requestingUrl: frame.url }),
    ],
    [true, false, false, false, false],
  );
  assert.ok(
    source.includes('C.mediaTypes.length===1&&C.mediaTypes[0]==="audio"'),
  );
});

const app = new URL(
  "../.runtime/VSCodium.app/Contents/Resources/app/",
  import.meta.url,
);
test(
  "patched runtime preserves exact CSP hashes and recorded integrity checksums",
  { skip: !existsSync(app) },
  () => {
    const pre = readFileSync(
      new URL("out/vs/workbench/contrib/webview/browser/pre/index.html", app),
      "utf8",
    );
    const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(pre)?.[1];
    assert.ok(script);
    const hash = createHash("sha256").update(script).digest("base64");
    assert.ok(pre.includes(`script-src 'sha256-${hash}'`));
    const product = JSON.parse(
      readFileSync(new URL("product.json", app), "utf8"),
    ) as { checksums: Record<string, string> };
    for (const [relative, expected] of Object.entries(product.checksums)) {
      assert.equal(
        createHash("sha256")
          .update(readFileSync(new URL("out/" + relative, app)))
          .digest("base64")
          .replace(/=+$/, ""),
        expected,
        relative,
      );
    }
  },
);
