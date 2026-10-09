import { test } from "node:test";
import assert from "node:assert/strict";

const moduleUrl = new URL("../scripts/together-evaluation.mjs", import.meta.url)
  .href;
const { evaluateModel } = await import(moduleUrl);
const key = "synthetic-credential-for-test";
const structured = JSON.stringify({
  summary: "Source-backed summary",
  evidence: [{ path: "services/orders/main.py", line: 4 }],
  unknowns: ["No failure handling shown"],
});

test("Together evaluation roundtrips only synthetic reads and excludes reasoning/secrets from reports", async () => {
  const requests: Record<string, unknown>[] = [];
  const report = await evaluateModel({
    model: "requested/model",
    apiKey: key,
    fetcher: async (url: string, options: RequestInit) => {
      assert.equal(url, "https://api.together.ai/v1/chat/completions");
      assert.equal(options.redirect, "error");
      assert.equal(
        (options.headers as Record<string, string>).Authorization,
        `Bearer ${key}`,
      );
      const body = JSON.parse(String(options.body));
      requests.push(body);
      assert.equal(body.model, "requested/model");
      const tool = body.tools;
      const isReview = body.messages[1].content.startsWith("Review");
      const message = tool
        ? {
            role: "assistant",
            content: null,
            reasoning_content: "INTERNAL_REASONING_NEVER_REPORT",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"services/orders/main.py"}',
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: body.response_format
              ? isReview
                ? structured.replace("services/orders/main.py", "retry.py")
                : structured
              : `Short answer ${key}`,
            reasoning: "INTERNAL_REASONING_NEVER_REPORT",
          };
      return new Response(
        JSON.stringify({
          choices: [{ message, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 20 },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(requests.length, 5);
  assert.equal(report.results.length, 4);
  assert.ok(report.results.every((r: { ok: boolean }) => r.ok));
  assert.equal(report.results[3].toolVerified, true);
  const history = requests[4].messages as {
    role: string;
    tool_call_id?: string;
    content?: string;
  }[];
  assert.equal(history.at(-1)?.role, "tool");
  assert.equal(history.at(-1)?.tool_call_id, "call-1");
  assert.match(history.at(-1)?.content ?? "", /def place_order/);
  assert.doesNotMatch(
    JSON.stringify(report),
    /INTERNAL_REASONING_NEVER_REPORT|synthetic-credential-for-test/,
  );
});

test("Together evaluation rejects truncated answers, invalid evidence and unauthorized fixture calls", async () => {
  let calls = 0;
  const report = await evaluateModel({
    model: "requested/model",
    apiKey: key,
    fetcher: async (_url: string, options: RequestInit) => {
      calls++;
      const body = JSON.parse(String(options.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: calls === 1 ? "length" : "stop",
              message: body.tools
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "x",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: '{"path":"/Users/private/.env"}',
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: structured.replace('"line":4', '"line":999'),
                  },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(calls, 4);
  assert.ok(report.results.every((r: { ok: boolean }) => !r.ok));
  assert.match(report.results[0].error, /truncated/);
  assert.equal(report.results[1].structureValid, false);
  assert.match(report.results[3].error, /outside requested synthetic target/);
});

test("Together authentication failure stops calls and never reads provider error bodies", async () => {
  let calls = 0;
  const report = await evaluateModel({
    model: "requested/model",
    apiKey: key,
    fetcher: async () => {
      calls++;
      return {
        ok: false,
        status: 401,
        json: () => {
          throw new Error("Sensitive body must not be read");
        },
      };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    report.results.map((r: { error: string }) => r.error),
    ["Together HTTP 401"],
  );
  assert.doesNotMatch(JSON.stringify(report), /Sensitive|synthetic-credential/);
});
