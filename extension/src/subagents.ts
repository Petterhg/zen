import { READ_TOOLS } from "./tool-registry.js";
import type { Effort } from "./task-policy.js";

export const RESEARCH_MODELS = [
  "deepseek-ai/DeepSeek-V4.1-Flash",
  "deepseek-ai/DeepSeek-V4-Pro-0813",
  "zai-org/GLM-5.3-Flash",
] as const;
export type ResearchModel = (typeof RESEARCH_MODELS)[number];
export type AgentId = string;
export interface ResearchAgent {
  name: string;
  description: string;
  mode: "foreground" | "background";
  orientation: boolean;
  tools: string[];
  workspace: "shared" | "isolated-worktree";
  enabled: boolean;
  model: ResearchModel;
  reasoningEffort: Effort;
  instructions: string;
}
export type ResearchAgents = Record<AgentId, ResearchAgent>;
export const DEFAULT_AGENTS: ResearchAgents = {
  explorer: {
    name: "Explorer",
    description:
      "Use for service discovery, code relationships and source-backed explanations.",
    mode: "foreground",
    orientation: true,
    tools: [...READ_TOOLS, "web_search", "fetch_page"],
    workspace: "shared",
    enabled: true,
    model: RESEARCH_MODELS[0],
    reasoningEffort: "medium",
    instructions:
      "Find the relevant service and code quickly. Explain its purpose and relevant dependencies with verified citations; expand only the gaps needed for the human's question.",
  },
  deep_research: {
    name: "Deep research",
    description:
      "Use for complex architecture, cross-service reasoning and subtle failure modes.",
    mode: "foreground",
    orientation: false,
    tools: [...READ_TOOLS, "web_search", "fetch_page"],
    workspace: "shared",
    enabled: true,
    model: RESEARCH_MODELS[1],
    reasoningEffort: "high",
    instructions:
      "Investigate complex cross-service behavior, architectural tradeoffs and subtle failure modes. Challenge assumptions, inspect both sides of contracts and relevant tests, and distinguish proven behavior from unknowns.",
  },
};

/** Versioned registry distinguishes an intentionally empty list from legacy defaults. */
export function agentRegistry(agents: ResearchAgents) {
  return { version: 2, agents };
}
export function researchAgents(input: unknown): ResearchAgents {
  if (input === undefined) input = {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Subagent settings must be an object.");
  const raw = input as Record<string, unknown>;
  const modern = raw.version === 2;
  if (
    modern &&
    Object.keys(raw).some((k) => !["version", "agents"].includes(k))
  )
    throw new Error("Unknown registry setting.");
  const source = (modern ? raw.agents : raw) as Record<string, unknown>;
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new Error("Invalid agent registry.");
  if (Object.keys(source).length > 32)
    throw new Error("Use at most 32 subagents.");
  if (
    !modern &&
    Object.keys(source).some((id) => !Object.hasOwn(DEFAULT_AGENTS, id))
  )
    throw new Error("Unknown legacy subagent profile.");
  const entries = modern
    ? Object.entries(source)
    : Object.keys(DEFAULT_AGENTS).map((id) => [id, source[id] ?? {}] as const);
  const agents = Object.fromEntries(
    entries.map(([id, value]) => {
      if (
        !/^[a-z][a-z0-9_-]{0,63}$/.test(id) ||
        ["main", "constructor", "prototype", "__proto__"].includes(id)
      )
        throw new Error(
          "Agent IDs must start with a letter and contain only lowercase letters, numbers, _ or -.",
        );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid ${id} profile.`);
      const fields = value as Record<string, unknown>;
      const defaults = modern
        ? {
            tools: [...READ_TOOLS, "web_search", "fetch_page"],
            workspace: "shared",
          }
        : DEFAULT_AGENTS[id];
      if (
        Object.keys(fields).some(
          (k) => !Object.hasOwn(DEFAULT_AGENTS.explorer, k),
        )
      )
        throw new Error(`Unknown ${id} setting.`);
      const agent = { ...defaults, ...fields } as ResearchAgent;
      if (
        typeof agent.name !== "string" ||
        !agent.name.trim() ||
        agent.name.length > 80 ||
        typeof agent.description !== "string" ||
        !agent.description.trim() ||
        agent.description.length > 2000 ||
        !["foreground", "background"].includes(agent.mode) ||
        typeof agent.orientation !== "boolean" ||
        !Array.isArray(agent.tools) ||
        agent.tools.length > 64 ||
        agent.tools.some(
          (t) => typeof t !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(t),
        ) ||
        !["shared", "isolated-worktree"].includes(agent.workspace) ||
        (agent.tools.includes("apply_patch") &&
          agent.workspace !== "isolated-worktree") ||
        typeof agent.enabled !== "boolean" ||
        !RESEARCH_MODELS.includes(agent.model) ||
        !["none", "low", "medium", "high"].includes(agent.reasoningEffort) ||
        typeof agent.instructions !== "string" ||
        agent.instructions.length > 8000
      )
        throw new Error(
          `Invalid ${id} definition. Name, description, model, execution mode and instructions are required (instructions: 8,000 characters maximum).`,
        );
      return [id, { ...agent, tools: [...agent.tools] }];
    }),
  ) as ResearchAgents;
  if (Object.values(agents).filter((a) => a.orientation).length > 1)
    throw new Error(
      "Choose at most one agent for automatic service orientation.",
    );
  return agents;
}

export function researchChoice(
  agents: ResearchAgents,
  effort: Effort,
): AgentId {
  return (effort === "high" || !agents.explorer?.enabled) &&
    agents.deep_research?.enabled
    ? "deep_research"
    : "explorer";
}

/** Together does not document numeric effort levels for these DeepSeek models. */
export function togetherReasoning(effort: Effort) {
  return {
    parameters: { reasoning: { enabled: effort !== "none" } },
    guidance:
      effort === "high"
        ? "Investigate relevant alternate explanations and failure cases carefully. Keep the final answer compact and source-backed."
        : effort === "medium"
          ? "Use enough reasoning to verify the question's relevant evidence; avoid unrelated analysis."
          : "Be succinct in your thinking and answer directly from verified evidence.",
  };
}
