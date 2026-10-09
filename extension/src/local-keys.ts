import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

/** Only the application's local development .env is read; never a workspace's .env. */
export async function localKey(
  file: string,
  name: string,
): Promise<string | undefined> {
  if (
    ![
      "OPENAI_API_KEY",
      "GROQ_API_KEY",
      "CEREBRAS_API_KEY",
      "FIRECRAWL_API_KEY",
      "TOGETHER_API_KEY",
    ].includes(name)
  )
    return undefined;
  try {
    const source = await readFile(file, "utf8");
    if (source.length > 64000) throw new Error("Local key file is too large.");
    return parseEnv(source)[name]?.trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Could not read the application's local key file.");
  }
}
