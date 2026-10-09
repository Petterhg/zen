import type { Effort } from "./task-policy.js";

export const RESEARCH_MODELS = [
  "deepseek-ai/DeepSeek-V4.1-Flash",
  "deepseek-ai/DeepSeek-V4-Pro-0813",
  "zai-org/GLM-5.3-Flash",
] as const;
export type ResearchModel = (typeof RESEARCH_MODELS)[number];
export type AgentId = "explorer" | "deep_research";
export interface ResearchAgent {
  enabled: boolean;
  model: ResearchModel;
  reasoningEffort: Effort;
  instructions: string;
}
export type ResearchAgents = Record<AgentId, ResearchAgent>;
export const DEFAULT_AGENTS: ResearchAgents = {
  explorer: {
    enabled: true,
    model: RESEARCH_MODELS[0],
    reasoningEffort: "medium",
    instructions:
      "Find the relevant service and code quickly. Explain its purpose and relevant dependencies with verified citations; expand only the gaps needed for the human's question.",
  },
  deep_research: {
    enabled: true,
    model: RESEARCH_MODELS[1],
    reasoningEffort: "high",
    instructions:
      "Investigate complex cross-service behavior, architectural tradeoffs and subtle failure modes. Challenge assumptions, inspect both sides of contracts and relevant tests, and distinguish proven behavior from unknowns.",
  },
};

/** Application-owned profiles only. Custom instructions never grant capabilities. */
export function researchAgents(input: unknown): ResearchAgents {
  if (input === undefined) input = {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Subagent settings must be an object.");
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some((id) => !Object.hasOwn(DEFAULT_AGENTS, id)))
    throw new Error("Unknown subagent profile.");
  return Object.fromEntries(
    Object.entries(DEFAULT_AGENTS).map(([id, defaults]) => {
      const value = source[id] ?? {};
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid ${id} profile.`);
      const fields = value as Record<string, unknown>;
      if (Object.keys(fields).some((k) => !Object.hasOwn(defaults, k)))
        throw new Error(`Unknown ${id} setting.`);
      const agent = { ...defaults, ...fields };
      if (
        typeof agent.enabled !== "boolean" ||
        !RESEARCH_MODELS.includes(agent.model) ||
        !["none", "low", "medium", "high"].includes(agent.reasoningEffort) ||
        typeof agent.instructions !== "string" ||
        agent.instructions.length > 8000
      )
        throw new Error(
          `Invalid ${id} model, reasoning or instructions (maximum 8,000 characters).`,
        );
      return [id, agent];
    }),
  ) as ResearchAgents;
}

export function researchChoice(
  agents: ResearchAgents,
  effort: Effort,
): AgentId {
  return (effort === "high" || !agents.explorer.enabled) &&
    agents.deep_research.enabled
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
