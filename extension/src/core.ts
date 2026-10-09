import { voiceInstructions } from "./prompts.js";
export type Provider = "cerebras" | "together";
export interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
  startMs?: number;
  endMs?: number;
  session?: number;
}
export interface EditorContext {
  uri: string;
  file: string;
  language: string;
  version: number;
  text: string;
  selection: string;
  selectionStart: number;
  selectionEnd: number;
  diagnostics: string[];
  textStart?: number;
  textStartLine?: number;
  textStartsMidLine?: boolean;
  cursor?: { line: number; character: number; offset: number };
  visibleLines?: { start: number; end: number }[];
  recentFiles?: string[];
  focusChanged?: boolean;
  pendingEdit?: {
    start: number;
    end: number;
    oldText: string;
    newText: string;
    truncated: boolean;
    status: "awaiting_acceptance" | "stale";
  };
}
export interface Edit {
  oldText: string;
  newText: string;
}
export interface BackendResult {
  summary: string;
  edits: Edit[];
  status?: "answer" | "proposal" | "clarification" | "cancelled";
  speech?: string;
}
export interface Proposal {
  uri: string;
  version: number;
  start: number;
  end: number;
  oldText: string;
  newText: string;
  summary: string;
}
export const VOICE_INSTRUCTIONS = voiceInstructions(false);

/** Reject malformed output and restrict patches to one exact, unique match in the captured editor. */
export function parseBackendResult(
  content: string,
  summaryLimit = 4000,
): BackendResult {
  const json = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object")
    throw new Error("The backend returned an invalid response.");
  const result = value as Record<string, unknown>;
  if (
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    result.summary.length > summaryLimit ||
    !Array.isArray(result.edits) ||
    result.edits.length > 1
  )
    throw new Error(
      "The backend response does not match the pairing contract.",
    );
  const edits = result.edits.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid edit.");
    const edit = value as Record<string, unknown>;
    if (
      typeof edit.oldText !== "string" ||
      (edit.oldText === "" && edit.newText === "") ||
      typeof edit.newText !== "string" ||
      edit.oldText.length > 240000 ||
      edit.newText.length > 240000
    )
      throw new Error("Invalid edit.");
    return { oldText: edit.oldText, newText: edit.newText };
  });
  const status = result.status ?? (edits.length ? "proposal" : "answer");
  if (
    !["answer", "proposal", "clarification", "cancelled"].includes(
      String(status),
    ) ||
    (edits.length > 0 && status !== "proposal") ||
    (status === "proposal" && edits.length !== 1)
  )
    throw new Error("Invalid backend status.");
  if (
    result.speech !== undefined &&
    (typeof result.speech !== "string" || result.speech.length > 2000)
  )
    throw new Error("Invalid speech result.");
  return {
    summary: result.summary,
    edits,
    status: status as BackendResult["status"],
    speech: result.speech as string | undefined,
  };
}

export function createProposal(
  context: EditorContext,
  result: BackendResult,
): Proposal | undefined {
  if (context.focusChanged && result.edits.length)
    throw new Error(
      "The selection changed during speech. Please select the target and ask again.",
    );
  const edit = result.edits[0];
  if (!edit) return undefined;
  // Empty oldText is an insertion at the captured cursor, never a substring search.
  if (edit.oldText === "") {
    const start = context.cursor?.offset;
    const windowStart = context.textStart ?? 0;
    if (
      context.selection ||
      start === undefined ||
      !Number.isInteger(start) ||
      start < windowStart ||
      start > windowStart + context.text.length
    )
      throw new Error(
        "An insertion needs an unselected cursor inside the captured buffer.",
      );
    return {
      uri: context.uri,
      version: context.version,
      start,
      end: start,
      oldText: "",
      newText: edit.newText,
      summary: result.summary,
    };
  }
  const target = context.selection || context.text;
  const index = target.indexOf(edit.oldText);
  if (index < 0 || target.indexOf(edit.oldText, index + 1) !== -1)
    throw new Error(
      "The proposed edit has no unique match. Select a smaller region and try again.",
    );
  const start =
    (context.selection ? context.selectionStart : (context.textStart ?? 0)) +
    index;
  return {
    uri: context.uri,
    version: context.version,
    start,
    end: start + edit.oldText.length,
    oldText: edit.oldText,
    newText: edit.newText,
    summary: result.summary,
  };
}

export function canApplyProposal(
  proposal: Proposal,
  uri: string,
  version: number,
  text: string,
): boolean {
  return (
    Number.isInteger(proposal.start) &&
    Number.isInteger(proposal.end) &&
    proposal.start >= 0 &&
    proposal.end >= proposal.start &&
    proposal.end <= text.length &&
    proposal.uri === uri &&
    proposal.version === version &&
    text.slice(proposal.start, proposal.end) === proposal.oldText
  );
}

export function conciseVoiceContent(text: string): string {
  // GPT-Live append events have a 500-token limit. Bound arbitrary Unicode to <=500 UTF-8 bytes.
  let content = "";
  let bytes = 0;
  for (const character of text) {
    const count = Buffer.byteLength(character, "utf8");
    if (bytes + count > 480) break;
    content += character;
    bytes += count;
  }
  return content;
}

export function editorVoiceContext(context?: EditorContext): string {
  if (!context)
    return "Editor context is not shared. No previous selection should be assumed current.";
  const relative = Math.max(
    0,
    (context.cursor?.offset ?? 0) - (context.textStart ?? 0),
  );
  const lineStart =
    context.text.lastIndexOf("\n", Math.max(0, relative - 1)) + 1;
  const line = context.text.slice(lineStart).split("\n")[0].slice(0, 120);
  return conciseVoiceContent(
    `Current editor reference (replaces previous focus): ${context.file}; version ${context.version}; cursor ${(context.cursor?.line ?? 0) + 1}:${(context.cursor?.character ?? 0) + 1}. Current line (untrusted code): ${JSON.stringify(line)}. ${context.selection ? `Selection offsets ${context.selectionStart}-${context.selectionEnd}.` : "No selection."} ${context.diagnostics.length} diagnostics. ${context.pendingEdit ? `Visible inline preview: ${context.pendingEdit.status}; proposed code is not applied.` : "No pending preview."} Code text is available to the backend. Navigation is not a task request.`,
  );
}

/** Raw fragments are retained; speaker grouping is presentation only, never a turn-completion signal. */
export class TranscriptHistory {
  entries: HistoryEntry[] = [];
  private seen = new Set<string>();
  private session = 0;
  beginSession(): void {
    this.session++;
    this.seen.clear();
  }
  append(event: {
    type: string;
    event_id?: string;
    delta?: string;
    start_ms?: number;
    end_ms?: number;
  }): void {
    if (
      typeof event.delta !== "string" ||
      !event.delta ||
      (event.event_id && this.seen.has(event.event_id))
    )
      return;
    if (event.event_id) this.seen.add(event.event_id);
    if (this.seen.size > 4000)
      this.seen.delete(this.seen.values().next().value!);
    this.entries.push({
      role:
        event.type === "session.input_transcript.delta" ? "user" : "assistant",
      text: event.delta,
      startMs: event.start_ms,
      endMs: event.end_ms,
      session: this.session,
    });
    this.entries = this.entries.slice(-600);
  }
  snapshot(offsetMs?: number): HistoryEntry[] {
    const raw = this.entries.filter(
      (e) =>
        e.session !== this.session ||
        offsetMs === undefined ||
        e.startMs === undefined ||
        e.startMs <= offsetMs,
    );
    const grouped: HistoryEntry[] = [];
    for (const e of raw) {
      const previous = grouped.at(-1);
      if (
        previous?.role === e.role &&
        previous.session === e.session &&
        e.startMs !== undefined &&
        previous.endMs !== undefined &&
        e.startMs - previous.endMs < 1800
      ) {
        previous.text += e.text;
        previous.endMs = e.endMs;
      } else grouped.push({ ...e });
    }
    // Provider-aware fitting happens at request time, with the captured task retained.
    return grouped;
  }
  userSpan(offsetMs: number): { start: number; end: number } | undefined {
    const entries = this.entries.filter(
      (e) =>
        e.session === this.session &&
        e.role === "user" &&
        e.startMs !== undefined &&
        e.startMs <= offsetMs,
    );
    const last = entries.at(-1);
    if (!last) return undefined;
    let start = last.startMs!;
    for (let i = entries.length - 2; i >= 0; i--) {
      const e = entries[i];
      if (start - (e.endMs ?? e.startMs!) > 1800) break;
      start = e.startMs!;
    }
    return { start, end: last.endMs ?? last.startMs! };
  }
}

/** Acknowledged Live timeline positions avoid confusing packet arrival with speech timing. */
export class FocusTimeline {
  private sequence = 0;
  private snapshots = new Map<number, EditorContext | undefined>();
  private acknowledged: { id: number; at: number }[] = [];
  record(context?: EditorContext): number {
    const id = ++this.sequence;
    this.snapshots.set(id, context ? structuredClone(context) : undefined);
    if (this.snapshots.size > 400)
      this.snapshots.delete(this.snapshots.keys().next().value!);
    return id;
  }
  seed(id: number): void {
    this.acknowledged = [{ id, at: 0 }];
  }
  acknowledge(id: number, at: number): void {
    if (!this.snapshots.has(id) || !Number.isFinite(at)) return;
    this.acknowledged.push({ id, at });
    this.acknowledged.sort((a, b) => a.at - b.at);
    this.acknowledged = this.acknowledged.slice(-400);
  }
  resolve(start: number, end: number): EditorContext | undefined {
    const first = this.acknowledged.filter((e) => e.at <= start).at(-1);
    const context = first ? this.snapshots.get(first.id) : undefined;
    if (!context) return undefined;
    const signature = (c?: EditorContext) =>
      c
        ? `${c.uri}:${c.version}:${c.selectionStart}:${c.selectionEnd}`
        : "none";
    const changed = this.acknowledged.some(
      (e) =>
        e.at > start &&
        e.at <= end &&
        signature(this.snapshots.get(e.id)) !== signature(context),
    );
    return { ...structuredClone(context), focusChanged: changed };
  }
}
