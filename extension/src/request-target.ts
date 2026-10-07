import type { EditorContext } from "./core.js";

/** Capture the human's local target when speech begins, independently of Live context delivery. */
export class RequestTargets {
  private spans: { start: number; end: number; context?: EditorContext }[] = [];
  private boundary = false;
  endTurn() {
    this.boundary = true;
  }
  append(
    event: { start_ms?: number; end_ms?: number; delta?: string },
    context?: EditorContext,
  ) {
    if (!event.delta?.trim() || event.start_ms === undefined) return;
    const previous = this.spans.at(-1);
    if (
      previous &&
      (!this.boundary || event.start_ms < previous.end) &&
      event.start_ms - previous.end < 1800 &&
      event.start_ms >= previous.start
    ) {
      previous.end = Math.max(previous.end, event.end_ms ?? event.start_ms);
    } else {
      this.spans.push({
        start: event.start_ms,
        end: event.end_ms ?? event.start_ms,
        context: context ? structuredClone(context) : undefined,
      });
      this.spans = this.spans.slice(-100);
    }
    this.boundary = false;
  }
  resolve(offset: number): { context?: EditorContext } | undefined {
    const span = this.spans.filter((s) => s.start <= offset).at(-1);
    return span
      ? { context: span.context ? structuredClone(span.context) : undefined }
      : undefined;
  }
  reset() {
    this.spans = [];
    this.boundary = false;
  }
}
