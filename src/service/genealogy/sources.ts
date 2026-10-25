import type { Work } from "../../shared/types";
import type { PaperType } from "../../shared/genealogy";
import type { FetchLike } from "../search/web-search";

/** A PMCID from OpenAlex's ids ("https://www.ncbi.nlm.nih.gov/pmc/articles/123456") or a bare "PMC123456". */
export function pmcidOf(work: Work): string | null {
  const ids = work.raw?.ids;
  const value = ids && typeof ids === "object" && "pmcid" in ids ? (ids as Record<string, unknown>).pmcid : work.bibFields?.pmcid;
  if (typeof value !== "string") return null;
  const match = value.match(/(?:PMC)?(\d{3,})\/?$/i);
  return match ? `PMC${match[1]}` : null;
}

/**
 * Open-access PMC articles among the works, by DOI or PMID, from Europe PMC's
 * search. OpenAlex no longer reports PMCIDs. Only open-access articles have
 * full text to fetch.
 */
export async function europePmcIds(works: Work[], signal: AbortSignal, fetcher: FetchLike = fetch): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const terms = works
    .map((w) => ({ w, term: w.doi ? `DOI:"${w.doi}"` : w.pmid ? `(EXT_ID:${w.pmid} AND SRC:MED)` : null }))
    .filter((x): x is { w: Work; term: string } => !!x.term);
  for (let i = 0; i < terms.length; i += 40) {
    const batch = terms.slice(i, i + 40);
    const params = new URLSearchParams({ query: batch.map((b) => b.term).join(" OR "), format: "json", resultType: "lite", pageSize: "100" });
    const response = await fetcher(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`, {
      headers: { "User-Agent": "ResearchBunny/1.0 (genealogy report)" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    });
    if (!response.ok) throw new Error(`Europe PMC HTTP ${response.status}`);
    const payload = (await response.json()) as { resultList?: { result?: { doi?: string; pmid?: string; pmcid?: string; isOpenAccess?: string }[] } };
    for (const r of payload.resultList?.result ?? []) {
      if (!r.pmcid || r.isOpenAccess !== "Y") continue;
      const match = batch.find(({ w }) => (r.doi && w.doi?.toLowerCase() === r.doi.toLowerCase()) || (r.pmid && w.pmid === r.pmid));
      if (match) found.set(match.w.id, r.pmcid);
    }
  }
  return found;
}

/** Europe PMC's JATS full text of an open-access PMC article, or null when it has none. */
export async function europePmcXml(pmcid: string, signal: AbortSignal, fetcher: FetchLike = fetch): Promise<string | null> {
  const response = await fetcher(`https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(pmcid)}/fullTextXML`, {
    headers: { Accept: "application/xml", "User-Agent": "ResearchBunny/1.0 (genealogy report)" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Europe PMC HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 20_000_000) throw new Error("Europe PMC 전문이 너무 큽니다.");
  return text.includes("<article") ? text : null;
}

/**
 * A paper type from bibliographic records, when they settle it. PubMed's
 * publication types come first; OpenAlex marks reviews but not meta-analyses.
 */
export function typeFromMetadata(work: Work, pubtypes: string[] | undefined): { type: PaperType; reason: string } | null {
  const types = (pubtypes ?? []).map((t) => t.toLowerCase());
  if (types.some((t) => t === "meta-analysis" || t === "systematic review" || t === "network meta-analysis"))
    return { type: "M", reason: `PubMed 출판 유형: ${pubtypes!.join(", ")}` };
  if (types.some((t) => ["review", "scoping review", "historical article", "editorial", "comment", "letter", "practice guideline", "guideline", "consensus development conference"].includes(t)))
    return { type: "R", reason: `PubMed 출판 유형: ${pubtypes!.join(", ")}` };
  if (work.type === "review") return { type: "R", reason: "OpenAlex 유형: review" };
  if (types.some((t) => /trial|observational study|comparative study|evaluation study|validation study|twin study|multicenter study|case reports/.test(t)))
    return { type: "O", reason: `PubMed 출판 유형: ${pubtypes!.join(", ")}` };
  return null;
}
