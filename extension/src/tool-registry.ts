import { Ajv, type ValidateFunction } from "ajv";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { BackendTool } from "./backend.js";

export const READ_TOOLS = [
  "read_file",
  "read_files",
  "find_files",
  "search_text",
  "workspace_overview",
  "search_code",
  "index_status",
  "symbol_usages",
  "diagnostics",
  "git_diff",
  "research_briefs",
  "service_context",
];
export const BUILTIN_TOOLS = [
  ...READ_TOOLS,
  "web_search",
  "fetch_page",
  "working_context",
  "code_focus",
  "recall_pairing_context",
  "remember_pairing_context",
  "delegate_to_agents",
  "agent_run",
  "apply_patch",
];
export const DEFAULT_MAIN_TOOLS = BUILTIN_TOOLS.filter(
  (name) => name !== "apply_patch",
);
export const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
export interface CommandTool {
  version: 1;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  runtime: {
    type: "command";
    command: string[];
    workingDirectory: "task-worktree";
    protocol: "json-stdio";
    timeoutMs: number;
  };
}
const ajv = new Ajv({
  strict: true,
  allErrors: false,
  validateFormats: false,
  addUsedSchema: false,
});
export function schemaValidator(
  schema: Record<string, unknown>,
): ValidateFunction {
  if (JSON.stringify(schema).length > 32000 || schema.type !== "object")
    throw new Error("Use an object JSON Schema of at most 32 KB.");
  // No remote resolution, custom executable keywords or asynchronous validation.
  if (JSON.stringify(schema).includes('"$async"'))
    throw new Error("Asynchronous schemas are not supported.");
  return ajv.compile(schema);
}
export function validateInput(
  schema: Record<string, unknown>,
  input: unknown,
): void {
  const validate = schemaValidator(schema);
  if (!validate(input))
    throw new Error(
      "Tool arguments do not match the schema: " +
        ajv.errorsText(validate.errors),
    );
}
export function commandTool(input: unknown): CommandTool {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid tool definition.");
  const t = input as CommandTool;
  if (
    Object.keys(t).some(
      (k) =>
        ![
          "version",
          "name",
          "description",
          "inputSchema",
          "outputSchema",
          "runtime",
        ].includes(k),
    ) ||
    t.version !== 1 ||
    !TOOL_ID.test(t.name) ||
    ["constructor", "prototype"].includes(t.name) ||
    BUILTIN_TOOLS.includes(t.name) ||
    typeof t.description !== "string" ||
    !t.description.trim() ||
    t.description.length > 2000 ||
    t.runtime?.type !== "command" ||
    t.runtime.workingDirectory !== "task-worktree" ||
    t.runtime.protocol !== "json-stdio" ||
    Object.keys(t.runtime).some(
      (k) =>
        ![
          "type",
          "command",
          "workingDirectory",
          "protocol",
          "timeoutMs",
        ].includes(k),
    ) ||
    !Array.isArray(t.runtime.command) ||
    !t.runtime.command.length ||
    t.runtime.command.length > 32 ||
    t.runtime.command.some(
      (arg) =>
        typeof arg !== "string" ||
        !arg ||
        arg.length > 4000 ||
        arg.includes("\0"),
    ) ||
    !Number.isInteger(t.runtime.timeoutMs) ||
    t.runtime.timeoutMs < 1000 ||
    t.runtime.timeoutMs > 600000
  )
    throw new Error(
      "Invalid command tool. Use a unique name, fixed argv, task-worktree / json-stdio and a timeout from 1–600 seconds.",
    );
  schemaValidator(t.inputSchema);
  if (t.outputSchema) schemaValidator(t.outputSchema);
  return structuredClone(t);
}
export const toolRevision = (tool: CommandTool) =>
  createHash("sha256").update(JSON.stringify(tool)).digest("hex");
export interface ToolEvent {
  name: string;
  status: "running" | "completed" | "failed";
  elapsedMs?: number;
  message?: string;
}

/** Approved local process execution, NOT a security sandbox. Never inherits provider keys. */
export async function executeCommand(
  tool: CommandTool,
  input: Record<string, unknown>,
  cwd: string,
  signal: AbortSignal,
  log: (text: string) => void = () => {},
): Promise<unknown> {
  validateInput(tool.inputSchema, input);
  signal.throwIfAborted();
  const inputBytes = JSON.stringify(input);
  if (Buffer.byteLength(inputBytes) > 256000)
    throw new Error("Tool input exceeds 256 KB.");
  const [executable, ...args] = tool.runtime.command;
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      env: Object.fromEntries(
        ["PATH", "SystemRoot", "LANG", "LC_ALL", "TMPDIR"].flatMap((key) =>
          process.env[key] ? [[key, process.env[key]!]] : [],
        ),
      ),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      bytes = 0,
      error: Error | undefined,
      stopped = false;
    const kill = () => {
      if (child.pid)
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
    };
    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = true;
      error = reason;
      kill();
    };
    const abort = () => stop(new Error("Tool cancelled."));
    const timer = setTimeout(
      () => stop(new Error("Tool timed out.")),
      tool.runtime.timeoutMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256000)
        stop(
          new Error(
            "Tool output exceeds 256 KB; return a compact structured result.",
          ),
        );
      else output += chunk.toString();
    });
    let logBytes = 0;
    child.stderr.on("data", (chunk) => {
      logBytes += chunk.length;
      if (logBytes <= 16000) log(chunk.toString());
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      error = e;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      kill();
      if (error) reject(error);
      else if (code !== 0)
        reject(new Error(`Tool exited with code ${code}; inspect its log.`));
      else resolve(output);
    });
    child.stdin.end(inputBytes + "\n");
  });
  signal.throwIfAborted();
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    throw new Error(
      "Tool stdout must contain one complete JSON object. Put logs on stderr.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tool result must be a JSON object.");
  if (tool.outputSchema) validateInput(tool.outputSchema, value);
  return value;
}

/** The same execution gate is used by main, children and the Settings test runner. */
export function gatedTool(
  tool: BackendTool,
  permitted: () => boolean,
  onEvent?: (event: ToolEvent) => void,
): BackendTool {
  return {
    ...tool,
    volatile: true,
    execute: async (input, signal) => {
      signal.throwIfAborted();
      if (!permitted())
        throw new Error(
          `${tool.name} is disabled, unassigned or its permission was revoked.`,
        );
      validateInput(tool.parameters, input);
      const start = Date.now();
      onEvent?.({ name: tool.name, status: "running" });
      try {
        const result = await tool.execute(input, signal);
        signal.throwIfAborted();
        if (!permitted())
          throw new Error("Tool permission changed; result withheld.");
        onEvent?.({
          name: tool.name,
          status: "completed",
          elapsedMs: Date.now() - start,
        });
        return result;
      } catch (error) {
        onEvent?.({
          name: tool.name,
          status: "failed",
          elapsedMs: Date.now() - start,
          message: error instanceof Error ? error.message : "Tool failed",
        });
        throw error;
      }
    },
  };
}
