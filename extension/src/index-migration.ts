import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  rename,
  readdir,
  readFile,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
/** Retire only disposable v1 code indexes; no keys, memory or session files. */
export async function retireLegacyIndexes(
  storage: string,
): Promise<{ retired: boolean; deferred: boolean }> {
  const source = path.join(storage, "indexes");
  try {
    const info = await lstat(source);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Legacy index path is not a directory.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { retired: false, deferred: false };
    throw e;
  }
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    try {
      const pid = Number(
        (
          await readFile(path.join(source, item.name, "owner.lock/pid"), "utf8")
        ).trim(),
      );
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return { retired: false, deferred: true };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH")
            return { retired: false, deferred: true };
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const retired = path.join(storage, `indexes-retired-${randomUUID()}`);
  try {
    await rename(source, retired);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { retired: false, deferred: false };
    throw e;
  }
  await rm(retired, { recursive: true, force: true });
  await writeFile(
    path.join(storage, "index-migration-shared-v2.json"),
    JSON.stringify({
      version: 2,
      retiredAt: new Date().toISOString(),
      strategy: "rebuild-from-current-permitted-source",
    }),
    { mode: 0o600 },
  );
  return { retired: true, deferred: false };
}
