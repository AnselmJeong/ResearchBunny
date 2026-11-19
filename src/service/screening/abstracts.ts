import type { Work } from "../../shared/types";
import { fetchPubMedAbstracts } from "../search/pubmed-search";
import type { FetchLike } from "../search/web-search";

const stripTags = (text: string) =>
  text
    .replace(/<\/?(?:h\d|p|br|sup|sub|i|b|em|strong|span|div)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Abstracts by DOI from Europe PMC, which also covers preprints and papers PubMed lacks. */
export async function europePmcAbstracts(dois: string[], signal: AbortSignal, fetcher: FetchLike = fetch): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const unique = [...new Set(dois.map((d) => d.toLowerCase()))];
  for (let i = 0; i < unique.length; i += 25) {
    const batch = unique.slice(i, i + 25);
    const params = new URLSearchParams({ query: batch.map((doi) => `DOI:"${doi.replace(/"/g, "")}"`).join(" OR "), format: "json", resultType: "core", pageSize: "100" });
    const response = await fetcher(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`, {
      headers: { "User-Agent": "ResearchBunny/1.0 (screening)" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    if (!response.ok) throw new Error(`Europe PMC HTTP ${response.status}`);
    const payload = (await response.json()) as { resultList?: { result?: { doi?: string; abstractText?: string }[] } };
    for (const r of payload.resultList?.result ?? []) {
      const doi = r.doi?.toLowerCase();
      const text = r.abstractText ? stripTags(r.abstractText) : "";
      if (doi && batch.includes(doi) && text.length > 40 && !found.has(doi)) found.set(doi, text);
    }
  }
  return found;
}

/**
 * Finds abstracts for works that have none: PubMed by PMID first, then Europe
 * PMC by DOI. Returns the abstracts found by work id; nothing is saved here.
 * A source that fails is skipped, so screening goes on with what it has.
 */
export async function findAbstracts(works: Work[], options: { signal: AbortSignal; pubmedKey?: string; fetcher?: FetchLike }): Promise<Map<string, { abstract: string; source: "pubmed" | "europepmc" }>> {
  const missing = works.filter((w) => !w.abstract?.trim());
  const found = new Map<string, { abstract: string; source: "pubmed" | "europepmc" }>();
  const byPmid = missing.filter((w) => w.pmid);
  if (byPmid.length)
    try {
      const abstracts = await fetchPubMedAbstracts(byPmid.map((w) => w.pmid!), { apiKey: options.pubmedKey, signal: options.signal, fetchFn: options.fetcher });
      for (const w of byPmid) {
        const text = abstracts.get(w.pmid!);
        if (text) found.set(w.id, { abstract: text, source: "pubmed" });
      }
    } catch {
      options.signal.throwIfAborted();
    }
  const byDoi = missing.filter((w) => !found.has(w.id) && w.doi);
  if (byDoi.length)
    try {
      const abstracts = await europePmcAbstracts(byDoi.map((w) => w.doi!), options.signal, options.fetcher);
      for (const w of byDoi) {
        const text = abstracts.get(w.doi!.toLowerCase());
        if (text) found.set(w.id, { abstract: text, source: "europepmc" });
      }
    } catch {
      options.signal.throwIfAborted();
    }
  return found;
}
