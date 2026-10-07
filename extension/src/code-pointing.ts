import type { EditorContext } from "./core.js";

export interface CodeReference {
  uri: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  label: string;
  mentions: string[];
}

export function codeReference(
  context: Pick<EditorContext, "uri" | "version" | "text" | "textStart">,
  quote: string,
  label: string,
  mentions: string[],
): CodeReference {
  const index = context.text.indexOf(quote);
  if (
    !quote.trim() ||
    quote.length > 2000 ||
    index < 0 ||
    context.text.indexOf(quote, index + 1) !== -1
  )
    throw new Error(
      "A code reference needs an exact unique quote from the current buffer.",
    );
  if (
    !label.trim() ||
    label.length > 80 ||
    mentions.length > 8 ||
    !mentions.length ||
    mentions.some((m) => m.length < 3 || m.length > 80)
  )
    throw new Error("Invalid code reference label or spoken mentions.");
  const start = (context.textStart ?? 0) + index;
  return {
    uri: context.uri,
    version: context.version,
    start,
    end: start + quote.length,
    quote,
    label,
    mentions,
  };
}

/** Lightweight fallback for common declaration heads, not a semantic project index. */
export function bufferReferences(context: EditorContext): CodeReference[] {
  const refs: CodeReference[] = [];
  const lines = context.text.split("\n");
  for (let i = 0; i < lines.length && refs.length < 32; i++) {
    const line = lines[i];
    const declaration = line.match(
      /^\s*(?:export\s+)?(?:async\s+)?(class|def|function)\s+([\p{L}\w]+)/u,
    );
    const field =
      context.language === "python"
        ? line.match(/^\s+([a-zA-Z_]\w*)\s*:\s*[\w[]/)
        : undefined;
    const connection = /\bsqlite3\.connect\s*\(/.test(line);
    if (!declaration && !field && !connection) continue;
    const label = declaration?.[2] ?? field?.[1] ?? "SQLite connection";
    const mentions = [label];
    if (declaration?.[1] === "class" && /\bBaseModel\b/.test(line))
      mentions.push("pydantic", "payload model", "payloadmodell");
    if (declaration?.[1] === "def") {
      const route = lines[i - 1]?.match(
        /^\s*@\w+\.(get|post|put|patch|delete)\s*\(/,
      );
      if (route)
        mentions.push(
          `${route[1]} endpoint`,
          `${route[1]} endpointen`,
          `${route[1]} route`,
        );
    }
    if (connection)
      mentions.push("sqlite", "databaskoppling", "database connection");
    try {
      refs.push(codeReference(context, line, label, mentions));
    } catch {
      /* Repeated heads are ambiguous. */
    }
  }
  // "the endpoint" is safe only when exactly one endpoint exists.
  const endpoints = refs.filter((r) =>
    r.mentions.some((m) => m.endsWith(" endpoint")),
  );
  if (endpoints.length === 1)
    endpoints[0].mentions.push("endpoint", "endpointen");
  return refs;
}

function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Follow newly spoken mentions, including words split across transcript packets. */
export class SpokenCodeFocus {
  private text = "";
  private endMs = -1;
  private seen = new Set<string>();
  reset(): void {
    this.text = "";
    this.endMs = -1;
    this.seen.clear();
  }
  append(
    event: {
      type: string;
      delta?: string;
      start_ms?: number;
      end_ms?: number;
      event_id?: string;
    },
    refs: CodeReference[],
  ): CodeReference | undefined {
    if (
      event.type !== "session.output_transcript.delta" ||
      typeof event.delta !== "string" ||
      typeof event.end_ms !== "number" ||
      event.end_ms < this.endMs ||
      (event.event_id && this.seen.has(event.event_id))
    )
      return;
    if (event.event_id) {
      this.seen.add(event.event_id);
      if (this.seen.size > 600)
        this.seen.delete(this.seen.values().next().value!);
    }
    if ((event.start_ms ?? event.end_ms) - this.endMs > 1800) this.text = "";
    this.endMs = event.end_ms;
    if (this.text.length > 400) this.text = this.text.slice(-300);
    const oldLength = normalize(this.text).length;
    this.text = (this.text + event.delta).slice(-600);
    const spoken = normalize(this.text);
    const aliases = new Map<string, CodeReference[]>();
    for (const ref of refs)
      for (const mention of ref.mentions) {
        const key = normalize(mention);
        const targets = aliases.get(key) ?? [];
        if (!targets.includes(ref)) targets.push(ref);
        aliases.set(key, targets);
      }
    let last = -1;
    let result: CodeReference | undefined;
    for (const [alias, targets] of aliases) {
      if (targets.length !== 1 || !alias) continue;
      const index = spoken.lastIndexOf(alias);
      const end = index + alias.length;
      if (
        index >= 0 &&
        end > oldLength &&
        index >= last &&
        (index === 0 || spoken[index - 1] === " ") &&
        (end === spoken.length || spoken[end] === " ")
      ) {
        last = index;
        result = targets[0];
      }
    }
    return result;
  }
}
