import {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";

// Explicit developer command; never read keys from an editor's open workspace.
const keyFile = process.argv[2];
const keys = {
  ...(keyFile ? parseEnv(readFileSync(path.resolve(keyFile), "utf8")) : {}),
  ...process.env,
};
if (!keys.OPENAI_API_KEY || !(keys.GROQ_API_KEY || keys.CEREBRAS_API_KEY)) {
  throw new Error(
    "Set OPENAI_API_KEY and GROQ_API_KEY or CEREBRAS_API_KEY, or pass your existing .env path.",
  );
}
const directory = path.join(homedir(), ".config/zen/hindsight");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const connection = path.join(directory, "connection.json");
if (!existsSync(connection))
  writeFileSync(
    connection,
    JSON.stringify({
      endpoint: "http://127.0.0.1:9077",
      token: randomBytes(32).toString("hex"),
    }),
    { mode: 0o600, flag: "wx" },
  );
chmodSync(connection, 0o600);
const { endpoint, token } = JSON.parse(readFileSync(connection, "utf8"));
if (
  endpoint !== "http://127.0.0.1:9077" ||
  typeof token !== "string" ||
  token.length < 32
)
  throw new Error("Invalid local Hindsight connection file.");
const groq = Boolean(keys.GROQ_API_KEY);
const env = {
  ...process.env,
  HINDSIGHT_API_HOST: "127.0.0.1",
  HINDSIGHT_API_PORT: "9077",
  HINDSIGHT_API_DATABASE_URL: "pg0://zen-personal-memory",
  HINDSIGHT_API_TENANT_EXTENSION:
    "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension",
  HINDSIGHT_API_TENANT_API_KEY: token,
  HINDSIGHT_API_LLM_PROVIDER: "openai",
  HINDSIGHT_API_LLM_BASE_URL: groq
    ? "https://api.groq.com/openai/v1"
    : "https://api.cerebras.ai/v1",
  HINDSIGHT_API_LLM_API_KEY: groq ? keys.GROQ_API_KEY : keys.CEREBRAS_API_KEY,
  HINDSIGHT_API_LLM_MODEL: groq ? "qwen/qwen3.8-27b" : "qwen-3.8-27b",
  HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai",
  HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: keys.OPENAI_API_KEY,
  HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: "text-embedding-3-small",
  HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS: "768",
  HINDSIGHT_API_RERANKER_PROVIDER: "rrf",
};
console.log(
  "Starting local Hindsight at " +
    endpoint +
    ". Select Personal memory → Connect local Hindsight in Zen. Keep this terminal open; Ctrl+C stops the service.",
);
const child = spawn(
  keys.UVX_PATH || "uvx",
  [
    "--from",
    "hindsight-api==0.10.2",
    "hindsight-api",
    "--host",
    "127.0.0.1",
    "--port",
    "9077",
  ],
  { env, stdio: "inherit" },
);
child.on("error", () => {
  console.error(
    "Could not launch uvx. Install uv, or set UVX_PATH to its executable.",
  );
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
