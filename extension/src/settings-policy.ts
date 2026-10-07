/** Display/pacing changes must not cancel an ongoing coding or research task. */
export function configurationRequiresCancellation(
  affects: (name: string) => boolean,
): boolean {
  return [
    "backend",
    "groqModel",
    "cerebrasModel",
    "reasoningEffort",
    "backendTimeoutSeconds",
    "shareEditorContext",
    "voice",
  ].some((name) => affects(`pairCode.${name}`));
}
