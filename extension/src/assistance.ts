import type { BackendResult } from "./core.js";

export const DEFAULT_ASSISTANCE = 25;
export function assistanceLevel(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : DEFAULT_ASSISTANCE;
}
export function assistancePolicy(value: unknown) {
  const level = assistanceLevel(value);
  const maxLines = level * 10;
  const band = level === 0 ? 0 : Math.ceil(level / 25);
  const labels = [
    "Voice only",
    "One small step",
    "Build together",
    "Draft a section",
    "Draft it for me",
  ];
  const instructions = [
    "Coach exactly one line or concrete action, explain its purpose briefly, then wait for the human to do it and ask for the next step. Start with the next useful line immediately: the style is already chosen, so do not ask permission to coach or ask the human to confirm typing. Return no edits, even for implementation requests. You may name the exact single line to type; never give a whole code example. Do not advance on navigation or editor updates alone.",
    `Explain one small next step, then wait. Learning questions receive guidance, not generated code. Only an explicit request to write or change code gets a tiny preview of at most ${maxLines} changed lines. Do not complete the surrounding implementation or offer a full scaffold.`,
    `Work one logical piece at a time. Briefly explain the approach. Only an explicit write/change request gets a preview of at most ${maxLines} changed lines; learning questions receive guidance. Pause after each piece before continuing.`,
    `On a write/change request, draft one coherent section of at most ${maxLines} changed lines, explain its role, then wait for review before continuing. Learning questions still receive guidance. Do not expand into unrelated work.`,
    "On a write/change request, draft the requested implementation as one focused preview, then ask if there is any part the human wants clarified. Learning questions receive explanations unless the human asks for code. Stay within the requested scope.",
  ];
  return {
    level,
    label: labels[band],
    maxLines,
    instruction: instructions[band],
  };
}
export function assistanceInstructions(value: unknown): string {
  const policy = assistancePolicy(value);
  return `Current pairing style ${policy.level}/100 (${policy.label}) replaces all earlier pairing styles. ${policy.instruction} Every preview still requires human acceptance; never apply it automatically.`;
}
export function assistanceViolation(
  result: BackendResult,
  value: unknown,
): string | undefined {
  const policy = assistancePolicy(value);
  if (!result.edits.length) return undefined;
  if (policy.level === 0)
    return "Guide mode requires no edits: give just one line or concrete action for the human, then wait.";
  const lines = result.edits.reduce((total, edit) => {
    const before = edit.oldText.split("\n");
    const after = edit.newText.replace(/\n$/, "").split("\n");
    let start = 0,
      end = 0;
    while (
      start < before.length &&
      start < after.length &&
      before[start] === after[start]
    )
      start++;
    while (
      end < before.length - start &&
      end < after.length - start &&
      before[before.length - 1 - end] === after[after.length - 1 - end]
    )
      end++;
    return total + Math.max(0, after.length - start - end);
  }, 0);
  if (lines > policy.maxLines)
    return `The preview exceeds the current ${policy.maxLines}-line step budget. Return one smaller coherent change or guidance with no edits; do not truncate code or omit necessary existing code.`;
  return undefined;
}

// Keep dynamic Live instructions intact within the app's conservative 480-byte append budget.
export function voiceAssistanceInstructions(value: unknown): string {
  const policy = assistancePolicy(value);
  const behavior =
    policy.level === 0
      ? "Coach one line/action and its purpose, then wait for the human to do it and ask for the next step. No previews. For the next request, say the exact line without a permission question. Navigation never means continue."
      : policy.level > 75
        ? "For write/change requests, draft the requested code, then ask what needs clarification and wait."
        : `Explain one step; for explicit write/change requests only, prepare at most ${policy.maxLines} new lines, then wait.`;
  return `Pairing style now ${policy.level}/100 (${policy.label}); replaces previous styles. ${behavior} Learning questions need guidance. Every preview needs human acceptance. Apply to future replies; do not announce the change or start a new task.`;
}
