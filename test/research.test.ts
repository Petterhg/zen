import { test } from "node:test";
import assert from "node:assert/strict";
import { researchFromTool } from "../extension/src/research.js";
test("research cards use fetched evidence and reject private, executable and failed source URLs", () => {
  const page = {
    url: "https://fastapi.tiangolo.com/tutorial/first-steps/",
    title: "First steps",
    markdown: "# First steps\nCode from documentation",
    status: 200,
  };
  assert.deepEqual(researchFromTool("fetch_page", page), [
    { url: page.url, title: page.title, text: page.markdown, kind: "page" },
  ]);
  for (const url of [
    "javascript:alert(1)",
    "https://localhost/test",
    "https://127.0.0.1/test",
    "https://user:secret@example.com/",
  ])
    assert.deepEqual(researchFromTool("fetch_page", { ...page, url }), []);
  assert.deepEqual(
    researchFromTool("fetch_page", { ...page, status: 403 }),
    [],
  );
  assert.equal(researchFromTool("read_file", page).length, 0);
  assert.equal(
    researchFromTool("web_search", {
      results: {
        web: [
          { url: page.url, title: page.title, description: "A search excerpt" },
        ],
      },
    })[0].kind,
    "search",
  );
});
