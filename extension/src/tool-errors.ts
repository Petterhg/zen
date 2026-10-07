/** Non-retryable infrastructure failure shared by tools in one request. */
export class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly domain: string,
  ) {
    super(message);
    this.name = "ToolFailure";
  }
}

export function isToolFailure(value: unknown): value is ToolFailure {
  return (
    value instanceof Error &&
    value.name === "ToolFailure" &&
    "code" in value &&
    typeof value.code === "string" &&
    "domain" in value &&
    typeof value.domain === "string"
  );
}
