export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 768;
export type Embed = (
  texts: string[],
  signal: AbortSignal,
) => Promise<number[][]>;
export function openAIEmbed(
  key: () => Promise<string | undefined>,
  fetcher: typeof fetch = fetch,
): Embed {
  return async (texts, signal) => {
    if (!texts.length) return [];
    if (
      texts.length > 32 ||
      texts.some((t) => !t.trim() || Buffer.byteLength(t) > 7500)
    )
      throw new Error("Invalid embedding batch.");
    const apiKey = await key();
    if (!apiKey)
      throw new Error("Configure an OpenAI API key for code indexing.");
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetcher("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          dimensions: EMBEDDING_DIMENSIONS,
          input: texts,
          encoding_format: "float",
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (
          attempt < 2 &&
          (response.status === 429 || response.status >= 500)
        ) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            const timer = setTimeout(
              () => {
                signal.removeEventListener("abort", abort);
                resolve();
              },
              500 * 2 ** attempt,
            );
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
          continue;
        }
        throw new Error(`Embedding request failed (HTTP ${response.status}).`);
      }
      const body = (await response.json()) as {
        data?: { index: number; embedding: number[] }[];
      };
      const vectors: number[][] = new Array(texts.length);
      for (const row of body.data ?? []) {
        if (
          !Number.isInteger(row.index) ||
          row.index < 0 ||
          row.index >= texts.length ||
          vectors[row.index] ||
          !Array.isArray(row.embedding) ||
          row.embedding.length !== EMBEDDING_DIMENSIONS ||
          row.embedding.some((n) => !Number.isFinite(n)) ||
          !row.embedding.some((n) => n !== 0)
        )
          throw new Error("Invalid embedding response; index unchanged.");
        vectors[row.index] = row.embedding;
      }
      if (vectors.filter(Boolean).length !== texts.length)
        throw new Error("Incomplete embedding response; index unchanged.");
      signal.throwIfAborted();
      return vectors;
    }
  };
}
