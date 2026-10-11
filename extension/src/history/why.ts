import type { HistoryRecord } from "./journal.js";
import { projectFile, type Origin } from "./model.js";

export interface ChangeReason {
  start: number;
  end: number;
  origin: Origin;
  observedAt?: string;
  request?: string;
  rationale?: string;
  attempts: {
    id: string;
    model?: string;
    provider?: string;
    effort?: string;
    phase?: string;
    retryOf?: string;
    outcomes: string[];
  }[];
}

/** Exact current-replica replay only. Never attribute by timestamp or nearby speech. */
export function explainSelection(
  records: HistoryRecord[],
  replicaId: string,
  file: string,
  text: string,
  start: number,
  end: number,
): ChangeReason[] | undefined {
  if (start < 0 || end < start || end > text.length)
    throw new Error("Invalid history selection.");
  const local = records.filter((r) => r.replicaId === replicaId);
  const state = projectFile(local, file);
  if (!state || state.text !== text) return undefined;
  const string = (value: unknown) =>
    typeof value === "string" ? value : undefined;
  const reasons: ChangeReason[] = [];
  for (const span of state.spans) {
    if (span.end <= start || span.start >= end) continue;
    const event = local.find((r) => r.id === span.origin.eventId);
    const proposal = local.find(
      (r) =>
        r.type === "proposal.created" &&
        r.data.file === file &&
        r.data.proposalId === span.origin.proposalId,
    );
    const request = span.origin.requestId
      ? local.find(
          (r) =>
            r.type === "request.observed" &&
            r.data.file === file &&
            r.data.requestId === span.origin.requestId,
        )
      : undefined;
    const ids = Array.isArray(proposal?.data.invocationIds)
      ? proposal.data.invocationIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [];
    const attempts = ids.flatMap((id) => {
      const chain = local.filter(
        (r) =>
          r.data.file === file &&
          r.data.requestId === span.origin.requestId &&
          r.data.invocationId === id,
      );
      const attempt = chain.find((r) => r.type === "provider.request");
      if (!attempt) return [];
      return [
        {
          id,
          model: string(attempt.data.model),
          provider: string(attempt.data.provider),
          effort: string(attempt.data.effectiveEffort),
          phase: string(attempt.data.phase),
          retryOf: string(attempt.data.retryOf),
          outcomes: chain
            .filter((r) => r.type !== "provider.request")
            .map((r) =>
              r.type === "provider.response"
                ? "Response received"
                : `Failure: ${string(r.data.category) || "unknown"}`,
            ),
        },
      ];
    });
    const reason: ChangeReason = {
      start: Math.max(start, span.start),
      end: Math.min(end, span.end),
      origin: span.origin,
      observedAt: event?.time,
      request: string(request?.data.input),
      rationale: string(proposal?.data.explanation),
      attempts,
    };
    const previous = reasons.at(-1);
    if (
      previous?.end === reason.start &&
      JSON.stringify(previous.origin) === JSON.stringify(reason.origin)
    )
      previous.end = reason.end;
    else reasons.push(reason);
  }
  return reasons;
}

/** Treat all recorded text as text, including markdown/HTML and command links. */
const literal = (value: string) =>
  value.replace(/[\\`*_{}[\]<>()#+.!|~-]/g, "\\$&");
export function renderReasons(
  file: string,
  reasons: ChangeReason[] | undefined,
): string {
  const lines = [
    "# Why did this change?",
    "",
    literal(file),
    "",
    "Local evidence for the selected text. This is stated rationale, not private reasoning or proof of a person's identity.",
    "",
  ];
  if (!reasons)
    return [
      ...lines,
      "No exact history matches this buffer. Earlier sessions and external edits are not inferred.",
    ].join("\n");
  if (!reasons.length)
    return [
      ...lines,
      "No surviving text is selected. Deleted text history is not available in this view.",
    ].join("\n");
  for (const reason of reasons) {
    const label = {
      human: "Human typing",
      ai: "Accepted AI proposal",
      imported: "Existing text — author unknown",
      editor_unknown: "Editor change — origin unknown",
    }[reason.origin.writer];
    lines.push(
      `## ${label}`,
      "",
      `Characters ${reason.start + 1}–${reason.end} (UTF-16). Operation: ${literal(reason.origin.operation)}.`,
      "",
    );
    if (reason.observedAt)
      lines.push(`Observed: ${literal(reason.observedAt)}`, "");
    if (reason.request)
      lines.push("### Your request", "", literal(reason.request), "");
    if (reason.rationale)
      lines.push("### Proposal rationale", "", literal(reason.rationale), "");
    if (reason.origin.writer === "human")
      lines.push(
        "No voice conversation is claimed to have caused this typing.",
        "",
      );
    if (reason.origin.writer === "ai" && !reason.request)
      lines.push("No originating request was captured for this proposal.", "");
    for (const attempt of reason.attempts)
      lines.push(
        `- ${literal(attempt.provider || "Unknown provider")} · ${literal(attempt.model || "Unknown model")} · effort: ${literal(attempt.effort || "unspecified")} · ${literal(attempt.phase || "unknown phase")}${attempt.retryOf ? " · retry" : ""}. ${literal(attempt.outcomes.join("; ") || "No outcome recorded")}`,
        "",
      );
  }
  lines.push(
    "Provider bodies and voice fragments are withheld. Saving, Git commit ownership, worker attribution and undo lineage are separate evidence.",
  );
  return lines.join("\n");
}
