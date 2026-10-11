import type { TextEdit } from "./model.js";

/** Textual lineage convention, not proof that equal bytes kept physical identity. */
export function replacementLineage(
  before: string,
  after: string,
): { edits: TextEdit[]; certain: boolean } {
  const a = Array.from(before),
    b = Array.from(after);
  const offsets = [0];
  for (const c of a) offsets.push(offsets.at(-1)! + c.length);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const x = a.slice(prefix, a.length - suffix),
    y = b.slice(prefix, b.length - suffix);
  const fallback = () => ({
    edits: [
      {
        start: offsets[prefix],
        end: offsets[a.length - suffix],
        text: y.join(""),
      },
    ],
    certain: false,
  });
  if (!x.length && !y.length) return { edits: [], certain: true };
  if ((x.length + 1) * (y.length + 1) > 250000) return fallback();
  const width = y.length + 1;
  const table = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      table[i * width + j] =
        x[i] === y[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  let i = 0,
    j = 0,
    start = 0,
    inserted = "";
  const edits: TextEdit[] = [];
  const flush = () => {
    if (start !== i || inserted)
      edits.push({
        start: offsets[prefix + start],
        end: offsets[prefix + i],
        text: inserted,
      });
    start = i;
    inserted = "";
  };
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      // Equal-character matching can also be ambiguous when another optimal path skips it.
      const score = table[i * width + j];
      if (
        table[(i + 1) * width + j] === score ||
        table[i * width + j + 1] === score
      )
        return fallback();
      flush();
      i++;
      j++;
      start = i;
    } else if (i < x.length && j < y.length) {
      const down = table[(i + 1) * width + j],
        right = table[i * width + j + 1];
      if (down === right && down > 0) return fallback();
      if (down >= right) i++;
      else inserted += y[j++];
    } else if (i < x.length) i++;
    else inserted += y[j++];
  }
  flush();
  return { edits, certain: true };
}
