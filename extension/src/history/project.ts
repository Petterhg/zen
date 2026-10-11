import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
const exec = promisify(execFile);
export interface HistoryProject {
  schemaVersion: 1;
  repositoryId: string;
}
export async function gitRoot(directory: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    timeout: 5000,
  });
  return realpath(stdout.trim());
}
export async function project(
  root: string,
  initialize = false,
): Promise<HistoryProject> {
  const directory = path.join(root, ".zen");
  if (initialize) await mkdir(directory, { mode: 0o755, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Unsafe .zen directory.");
  const file = path.join(directory, "project.json");
  if (initialize) {
    try {
      await writeFile(
        file,
        JSON.stringify(
          { schemaVersion: 1, repositoryId: randomUUID() },
          null,
          2,
        ) + "\n",
        { flag: "wx", mode: 0o644 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384)
    throw new Error("Unsafe history project metadata.");
  const parsed = JSON.parse(await readFile(file, "utf8")) as HistoryProject;
  if (
    parsed.schemaVersion !== 1 ||
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(
      parsed.repositoryId,
    )
  )
    throw new Error("Unsupported history project metadata.");
  return parsed;
}
