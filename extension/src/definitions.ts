import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  rename,
  unlink,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  researchAgents,
  agentRegistry,
  type ResearchAgents,
  type ResearchAgent,
} from "./subagents.js";
import {
  commandTool,
  toolRevision,
  DEFAULT_MAIN_TOOLS,
  type CommandTool,
  TOOL_ID,
} from "./tool-registry.js";
export interface LibraryPolicy {
  version: 1;
  disabled: string[];
  mainTools: string[];
  commandGrants: Record<string, string>;
}
const initialPolicy = (): LibraryPolicy => ({
  version: 1,
  disabled: [],
  mainTools: [...DEFAULT_MAIN_TOOLS],
  commandGrants: {},
});
function validatePolicy(policy: LibraryPolicy) {
  if (
    policy.version !== 1 ||
    ![policy.disabled, policy.mainTools].every(
      (v) =>
        Array.isArray(v) &&
        v.length <= 128 &&
        v.every((id) => typeof id === "string" && TOOL_ID.test(id)),
    ) ||
    !policy.commandGrants ||
    typeof policy.commandGrants !== "object" ||
    Array.isArray(policy.commandGrants) ||
    Object.values(policy.commandGrants).some(
      (v) => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v),
    )
  )
    throw new Error("Invalid tool library policy.");
}
export function agentMarkdown(agent: ResearchAgent): string {
  const { instructions, ...metadata } = agent;
  return `---\n${stringify(metadata)}---\n${instructions}\n`;
}
export function parseAgentMarkdown(text: string): ResearchAgent {
  if (text.length > 20000) throw new Error("Agent file exceeds 20 KB.");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match)
    throw new Error(
      "Agent files require YAML frontmatter followed by Markdown instructions.",
    );
  const metadata = parse(match[1], { maxAliasCount: 0 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Invalid agent metadata.");
  return researchAgents(
    agentRegistry({
      imported: { ...metadata, instructions: match[2].trimEnd() },
    }),
  ).imported;
}
async function safeRead(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256000)
    throw new Error("Definition must be a regular file smaller than 256 KB.");
  return readFile(file, "utf8");
}
async function atomic(file: string, content: string) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}
/** Canonical local files; legacy VS Code settings are read only for first migration. */
export class Definitions {
  agents: ResearchAgents = {};
  tools: Record<string, CommandTool> = {};
  policy = initialPolicy();
  revision = "";
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly folder: string,
    private changed: () => void = () => {},
  ) {}
  async initialize(legacy: unknown): Promise<void> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    for (const dir of ["agents", "tools"])
      await mkdir(path.join(this.folder, dir), {
        recursive: true,
        mode: 0o700,
      });
    try {
      await safeRead(path.join(this.folder, "library.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const agents = researchAgents(legacy);
      // Do not overwrite manually supplied definitions during first initialization.
      if (
        !(await readdir(path.join(this.folder, "agents"))).some((f) =>
          f.endsWith(".md"),
        )
      )
        for (const [id, agent] of Object.entries(agents))
          await atomic(
            path.join(this.folder, "agents", id + ".md"),
            agentMarkdown(agent),
          );
      await atomic(
        path.join(this.folder, "library.json"),
        JSON.stringify(initialPolicy(), null, 2),
      );
    }
    await this.reload();
  }
  async reload(): Promise<void> {
    const raw: string[] = [];
    const agents: ResearchAgents = {},
      tools: Record<string, CommandTool> = {};
    for (const dir of ["agents", "tools"]) {
      const files = (await readdir(path.join(this.folder, dir)))
        .filter((f) => f.endsWith(dir === "agents" ? ".md" : ".json"))
        .sort();
      if (files.length > 64)
        throw new Error(
          "Too many definition files (maximum 64 per directory).",
        );
      for (const file of files) {
        const id = file.slice(0, file.lastIndexOf("."));
        if (
          !/^[a-z][a-z0-9_-]{0,63}$/.test(id) ||
          ["constructor", "prototype", "__proto__"].includes(id)
        )
          throw new Error("Invalid definition filename.");
        const text = await safeRead(path.join(this.folder, dir, file));
        raw.push(dir + file + text);
        if (dir === "agents") agents[id] = parseAgentMarkdown(text);
        else {
          const tool = commandTool(JSON.parse(text));
          if (tool.name !== id)
            throw new Error("Tool filename must match its name.");
          tools[id] = tool;
        }
      }
    }
    const text = await safeRead(path.join(this.folder, "library.json"));
    raw.push(text);
    const policy = JSON.parse(text) as LibraryPolicy;
    validatePolicy(policy);
    this.agents = researchAgents(agentRegistry(agents));
    this.tools = tools;
    this.policy = policy;
    this.revision = createHash("sha256")
      .update(JSON.stringify(raw))
      .digest("hex");
  }
  private async mutate(revision: string, fn: () => Promise<void>) {
    const job = this.queue.then(async () => {
      const lock = path.join(this.folder, ".write-lock");
      try {
        await mkdir(lock);
      } catch {
        throw new Error(
          "Another settings save is active. Retry; if an editor crashed, remove the .write-lock directory in the definitions folder.",
        );
      }
      try {
        await this.reload();
        if (revision !== this.revision)
          throw new Error(
            "Definitions changed in another view. Reload saved before saving.",
          );
        await fn();
        await this.reload();
        this.changed();
      } finally {
        await import("node:fs/promises").then((fs) => fs.rmdir(lock));
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
  saveAgents(input: unknown, revision: string) {
    const agents = researchAgents({ version: 2, agents: input });
    return this.mutate(revision, async () => {
      for (const [id, agent] of Object.entries(agents))
        await atomic(
          path.join(this.folder, "agents", id + ".md"),
          agentMarkdown(agent),
        );
      for (const id of Object.keys(this.agents))
        if (!Object.hasOwn(agents, id))
          await unlink(path.join(this.folder, "agents", id + ".md"));
    });
  }
  saveTool(input: unknown, revision: string) {
    const tool = commandTool(input);
    return this.mutate(revision, async () => {
      if (
        !Object.hasOwn(this.tools, tool.name) ||
        toolRevision(this.tools[tool.name]) !== toolRevision(tool)
      ) {
        const policy = structuredClone(this.policy);
        delete policy.commandGrants[tool.name];
        await atomic(
          path.join(this.folder, "library.json"),
          JSON.stringify(policy, null, 2),
        );
      }
      await atomic(
        path.join(this.folder, "tools", tool.name + ".json"),
        JSON.stringify(tool, null, 2),
      );
    });
  }
  deleteTool(name: string, revision: string) {
    if (!Object.hasOwn(this.tools, name))
      throw new Error("Custom tool not found.");
    return this.mutate(revision, async () => {
      const policy = structuredClone(this.policy);
      delete policy.commandGrants[name];
      policy.mainTools = policy.mainTools.filter((t) => t !== name);
      await atomic(
        path.join(this.folder, "library.json"),
        JSON.stringify(policy, null, 2),
      );
      await unlink(path.join(this.folder, "tools", name + ".json"));
    });
  }
  savePolicy(policy: LibraryPolicy, revision: string) {
    validatePolicy(policy);
    return this.mutate(revision, () =>
      atomic(
        path.join(this.folder, "library.json"),
        JSON.stringify(policy, null, 2),
      ),
    );
  }
  enabled(name: string) {
    return !this.policy.disabled.includes(name);
  }
  granted(tool: CommandTool) {
    return this.policy.commandGrants[tool.name] === toolRevision(tool);
  }
}
