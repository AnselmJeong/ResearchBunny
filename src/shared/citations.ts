/**
 * Pandoc citation keys in Markdown: "[@a; @b, p. 5]" and narrative "@a".
 * Keys may hold inner punctuation (":", ".", "-") but never end with it, and an
 * "@" right after a letter or digit (an e-mail address) is not a citation.
 */
export const CITATION = /(?<![\p{L}\p{N}_])@([\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.-](?=[\p{L}\p{N}_]))*)/gu;

/** Keys in order of first citation. */
export function citedKeys(markdown: string): string[] {
  const seen = new Set<string>();
  for (const match of markdown.matchAll(CITATION)) seen.add(match[1]);
  return [...seen];
}

/** Numeric citations like "[3]" or "[1, 4–6]", which the report must not use. */
export const NUMERIC_CITATION = /\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/g;

/** Removes citations of the given keys, and brackets they leave empty. */
export function dropCitations(markdown: string, keys: Set<string>): string {
  return markdown
    .replace(/\[([^\]]*@[^\]]*)\]/g, (whole, inner: string) => {
      const parts = inner.split(";").map((p) => p.trim());
      const kept = parts.filter((p) => {
        const key = p.match(/@([\p{L}\p{N}_][\p{L}\p{N}_:.-]*[\p{L}\p{N}_]|[\p{L}\p{N}_])/u)?.[1];
        return !key || !keys.has(key);
      });
      return kept.length === parts.length ? whole : kept.length ? `[${kept.join("; ")}]` : "";
    })
    .replace(CITATION, (whole, key: string) => (keys.has(key) ? "" : whole))
    .replace(/ +([.,;:])/g, "$1")
    .replace(/ {2,}/g, " ");
}

/**
 * The report's citations as numbers in order of first appearance, as the
 * Vancouver style renders them; for previews in the app.
 */
export function numberCitations(markdown: string, order: Map<string, number>): string {
  const number = (key: string) => {
    if (!order.has(key)) order.set(key, order.size + 1);
    return order.get(key)!;
  };
  return markdown
    .replace(/\[([^\]]*@[^\]]*)\]/g, (whole, inner: string) => {
      const parts = inner.split(";").map((p) => p.trim());
      const rendered = parts.map((p) => {
        const m = p.match(/^-?@([\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.-](?=[\p{L}\p{N}_]))*)(.*)$/u);
        const locator = m?.[2].replace(/^[,\s]+/, "").trim();
        return m ? `${number(m[1])}${locator ? `, ${locator}` : ""}` : p;
      });
      return parts.some((p) => /^-?@/.test(p)) ? `[${rendered.join(", ")}]` : whole;
    })
    .replace(CITATION, (_whole, key: string) => `[${number(key)}]`);
}
