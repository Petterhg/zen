import { publicWebUrl } from "./tool-policy.js";
export interface ResearchArticle {
  url: string;
  title: string;
  text: string;
  kind: "page" | "search";
}
/** Display only actual tool results, with plain text and validated public links. */
export function researchFromTool(
  name: string,
  value: unknown,
): ResearchArticle[] {
  if (!value || typeof value !== "object") return [];
  const data = value as Record<string, unknown>;
  const candidates: unknown[] =
    name === "fetch_page"
      ? [data]
      : name === "web_search"
        ? Array.isArray(data.results)
          ? data.results
          : ((data.results as { web?: unknown[] } | undefined)?.web ?? [])
        : [];
  return candidates.slice(0, 8).flatMap((entry): ResearchArticle[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    try {
      if (typeof item.status === "number" && item.status >= 400) return [];
      const url = publicWebUrl(item.url);
      const text = name === "fetch_page" ? item.markdown : item.description;
      return [
        {
          url,
          title:
            typeof item.title === "string"
              ? item.title.slice(0, 180)
              : new URL(url).hostname,
          text:
            typeof text === "string"
              ? text.slice(0, name === "fetch_page" ? 11000 : 500)
              : "",
          kind: name === "fetch_page" ? "page" : "search",
        },
      ];
    } catch {
      return [];
    }
  });
}
