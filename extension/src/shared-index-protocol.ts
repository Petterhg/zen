import path from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, link, rm, lstat } from "node:fs/promises";
import type { Socket } from "node:net";
import type { DiscoveryRoot } from "./discovery.js";
export const SHARED_PROTOCOL = 2;
export const MAX_FRAME = 8 * 1024 * 1024;
export const sharedIndexDirectory = () =>
  path.join(homedir(), ".zen", "code-index", "shared-v2");
// Kernel port ownership replaces filesystem owner locks. Process death releases it.
export const sharedIndexPort = (directory: string) =>
  32000 +
  (createHash("sha256")
    .update(path.resolve(directory))
    .digest()
    .readUInt32BE(0) %
    20000);
export interface SharedRoot extends DiscoveryRoot {
  checkout: string;
}
export interface RootStatus {
  checkout: string;
  repository: string;
  state: string;
  files: number;
  chunks: number;
  coverageKnown: boolean;
  embedded: number;
  reused: number;
  processed?: number;
  total?: number;
  currentFile?: string;
  error?: string;
  updatedAt: number;
}
export async function indexSecret(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Invalid shared index directory.");
  if (process.platform !== "win32" && info.mode & 0o077)
    throw new Error("Shared index directory permissions are invalid.");
  const file = path.join(directory, "connection-token");
  try {
    return await readSecret(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const temporary = path.join(
    directory,
    `token-${randomBytes(12).toString("hex")}`,
  );
  await writeFile(temporary, randomBytes(32).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    await rm(temporary, { force: true });
  }
  return readSecret(file);
}
async function readSecret(file: string) {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (process.platform !== "win32" && info.mode & 0o077)
  )
    throw new Error("Shared index token permissions are invalid.");
  const value = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("Shared index token is invalid.");
  return value;
}
export function receiveFrames(
  socket: Socket,
  consume: (data: Record<string, unknown>) => void,
) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    let end: number;
    while ((end = buffer.indexOf(10)) >= 0) {
      if (end > MAX_FRAME) {
        socket.destroy();
        return;
      }
      const frame = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try {
        const value = JSON.parse(frame.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        consume(value);
      } catch {
        socket.destroy();
        return;
      }
    }
    if (buffer.length > MAX_FRAME) socket.destroy();
  });
}
export function sendFrame(socket: Socket, value: object): boolean {
  const frame = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(frame) > MAX_FRAME || socket.destroyed) return false;
  // Slow/disconnected subscribers must never retain unbounded progress or source data.
  if (socket.writableLength > MAX_FRAME) {
    socket.destroy();
    return false;
  }
  socket.write(frame);
  return true;
}
