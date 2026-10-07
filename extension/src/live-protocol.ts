export interface PendingCommand {
  type: string;
  contextId?: number;
  sentAt: number;
}
export interface LiveAcknowledgment {
  type: string;
  client_event_id?: string;
  start_ms?: number;
  end_ms?: number;
  error?: { client_event_id?: string; message?: string };
}
/** Command acceptance is separate from audio playback; no automatic retry of uncertain appends. */
export class CommandLedger {
  private pending = new Map<string, PendingCommand>();
  track(id: string, type: string, contextId?: number): void {
    if (this.pending.size >= 128)
      throw new Error(
        "Too many unacknowledged voice updates. Reconnect the voice session.",
      );
    this.pending.set(id, { type, contextId, sentAt: Date.now() });
  }
  receive(
    event: LiveAcknowledgment,
  ): (PendingCommand & { id: string; accepted: boolean }) | undefined {
    const id =
      event.type === "error"
        ? event.error?.client_event_id
        : event.client_event_id;
    if (!id) return undefined;
    const command = this.pending.get(id);
    if (!command) return undefined;
    const expected = command.type.endsWith(".append")
      ? command.type + "ed"
      : command.type + "d";
    if (event.type !== "error" && event.type !== expected) return undefined;
    this.pending.delete(id);
    return { ...command, id, accepted: event.type !== "error" };
  }
  get pendingContext(): boolean {
    return [...this.pending.values()].some((c) => c.contextId !== undefined);
  }
  get size(): number {
    return this.pending.size;
  }
  clear(): void {
    this.pending.clear();
  }
}
export function voiceContent(text: string, maxBytes = 480): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let value = "";
  for (const c of text) {
    const length = encoder.encode(c).length;
    if (bytes + length > maxBytes) break;
    value += c;
    bytes += length;
  }
  return value;
}

/** Passive editor state waits for speech/playback and rapid editing to settle.
 * Transcript silence alone is not proof that a complete answer has finished. */
export class PassiveContextWindow {
  private speechUntil = 0;
  private editingUntil = 0;
  speech(now: number): void {
    this.speechUntil = now + 1100;
  }
  edit(now: number): void {
    this.editingUntil = now + 600;
  }
  remaining(now: number): number {
    return Math.max(0, this.speechUntil - now, this.editingUntil - now);
  }
  reset(): void {
    this.speechUntil = 0;
    this.editingUntil = 0;
  }
}
