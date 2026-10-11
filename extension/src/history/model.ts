export interface Origin {
  writer: "human" | "ai" | "editor_unknown" | "imported";
  operation: string;
  proposalId?: string;
  requestId?: string;
}
export interface Span {
  start: number;
  end: number;
  origin: Origin;
}
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}
export interface DocumentHistory {
  text: string;
  spans: Span[];
}
export function baseline(text: string): DocumentHistory {
  return {
    text,
    spans: text.length
      ? [
          {
            start: 0,
            end: text.length,
            origin: { writer: "imported", operation: "baseline" },
          },
        ]
      : [],
  };
}
/** Offsets are UTF-16, matching VS Code; edits refer to the same before-snapshot. */
export function applyEdits(
  before: DocumentHistory,
  edits: TextEdit[],
  origin: Origin,
): DocumentHistory {
  let state = before;
  let previousStart = before.text.length + 1;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > before.text.length ||
      edit.end > previousStart ||
      edit.start === previousStart
    )
      throw new Error("Invalid or overlapping history edits.");
    previousStart = edit.start;
    const delta = edit.text.length - (edit.end - edit.start);
    const spans: Span[] = [];
    for (const span of state.spans) {
      if (span.start < edit.start)
        spans.push({ ...span, end: Math.min(span.end, edit.start) });
      if (span.end > edit.end)
        spans.push({
          ...span,
          start: Math.max(span.start, edit.end) + delta,
          end: span.end + delta,
        });
    }
    if (edit.text.length)
      spans.push({
        start: edit.start,
        end: edit.start + edit.text.length,
        origin,
      });
    state = {
      text:
        state.text.slice(0, edit.start) +
        edit.text +
        state.text.slice(edit.end),
      spans: spans.sort((a, b) => a.start - b.start),
    };
  }
  return state;
}
export function nativeOrigin(
  source?: string,
  kind?: unknown,
  reversal?: "undo" | "redo",
): Origin {
  if (reversal) return { writer: "editor_unknown", operation: reversal };
  if (source === "cursor" && kind === "type")
    return { writer: "human", operation: "typing" };
  return { writer: "editor_unknown", operation: source || "unavailable" };
}

/** Replay one replica only: editor versions are not global identities. Acceptance supplies explicit provenance. */
export function projectFile(
  records: import("./journal.js").HistoryRecord[],
  file: string,
): DocumentHistory | undefined {
  const local = records
    .filter((event) => event.data.file === file)
    .sort((a, b) => a.sequence - b.sequence);
  if (new Set(local.map((event) => event.replicaId)).size > 1)
    throw new Error("Project each replica independently.");
  const proposals = new Map(
    local
      .filter((event) => event.type === "proposal.created")
      .map((event) => [event.data.proposalId, event.data]),
  );
  const accepted = new Map(
    local
      .filter((event) => event.type === "proposal.accepted")
      .map((event) => [event.data.version, event.data]),
  );
  let state: DocumentHistory | undefined;
  for (const event of local) {
    if (event.type === "document.baseline") {
      const text = String(event.data.text);
      if (!state || state.text !== text) state = baseline(text);
    }
    if (event.type !== "document.changed") continue;
    const text = String(event.data.beforeText);
    if (!state || state.text !== text) state = baseline(text);
    const acceptance = accepted.get(event.data.version);
    const proposal = acceptance && proposals.get(acceptance.proposalId);
    const origin: Origin =
      acceptance &&
      proposal &&
      proposal.version === event.data.beforeVersion &&
      acceptance.text === event.data.text &&
      text.slice(Number(proposal.start), Number(proposal.end)) ===
        proposal.oldText &&
      text.slice(0, Number(proposal.start)) +
        proposal.newText +
        text.slice(Number(proposal.end)) ===
        event.data.text
        ? {
            writer: "ai",
            operation: "accepted-proposal",
            proposalId: String(acceptance.proposalId),
            requestId:
              typeof acceptance.requestId === "string"
                ? acceptance.requestId
                : undefined,
          }
        : (event.data.origin as Origin);
    const next = applyEdits(state, event.data.edits as TextEdit[], origin);
    if (next.text !== event.data.text)
      throw new Error("History replay does not match observed buffer.");
    state = next;
  }
  return state;
}
