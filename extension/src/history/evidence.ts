import { createHash } from "node:crypto";

export interface ProviderEvidence {
  type: "provider.request" | "provider.response" | "provider.failure";
  invocationId: string;
  retryOf?: string;
  provider: string;
  model: string;
  phase: string;
  effectiveEffort: string;
  retry: boolean;
  elapsedMs?: number;
  status?: number;
  category?: string;
  body?: unknown;
}
/** Sanitized evidence is a derivative, never advertised as byte-identical wire data. */
export function sanitizeEvidence(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "string") {
    if (/<\/?think>/i.test(value))
      return "[reasoning-bearing content withheld]";
    // Tool results and structured replies often enter provider messages as JSON strings.
    // Redact their fields too, without treating arbitrary source text as instructions.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed: unknown = JSON.parse(value);
        return JSON.stringify(sanitizeEvidence(parsed, secrets));
      } catch {
        /* Ordinary text or source; apply string redaction below. */
      }
    }
    let text = value;
    for (const secret of secrets)
      if (secret) text = text.split(secret).join("[credential redacted]");
    return text
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(
        /\b(?:sk-|csk-|gsk_|fc-)[A-Za-z0-9_-]{12,}/g,
        "[credential redacted]",
      );
  }
  if (Array.isArray(value))
    return value.map((item) => sanitizeEvidence(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:authorization|api[_-]?key|password|token|access_token|refresh_token)$/i.test(
          key,
        )
          ? "[credential redacted]"
          : /^(?:reasoning|reasoning_content)$/i.test(key) &&
              typeof item === "string"
            ? "[private reasoning omitted]"
            : sanitizeEvidence(item, secrets),
      ]),
    );
  return value;
}
export function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Multi-file bodies are withheld until every contributing path has an access manifest. */
export function inspectEvidence(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const { body, ...metadata } = data;
  return {
    ...metadata,
    ...(body !== undefined
      ? {
          body: "Encrypted body withheld: multi-file access manifest not yet available.",
        }
      : {}),
  };
}
