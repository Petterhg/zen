import path from "node:path";
import { realpath } from "node:fs/promises";

export function isPrivatePath(file: string): boolean {
  return /(^|[\\/])(\.env(?:\.[^\\/]*)?|\.git|\.aws|\.ssh|credentials|id_rsa|id_ed25519|node_modules)([\\/]|$)|\.(pem|key)$/i.test(
    file,
  );
}
export async function insideWorkspace(
  file: string,
  roots: string[],
): Promise<string> {
  const resolved = await realpath(file);
  if (isPrivatePath(resolved))
    throw new Error("This path is excluded from AI context.");
  for (const root of roots) {
    const base = await realpath(root);
    const relative = path.relative(base, resolved);
    if (
      relative &&
      !relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    )
      return resolved;
  }
  throw new Error("This file is outside the open workspace.");
}
export function publicWebUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 3000)
    throw new Error("A public HTTPS URL is required.");
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !host.includes(".") ||
    host.includes(":") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  )
    throw new Error("Only public HTTPS pages are supported by this tool.");
  return url.toString();
}
