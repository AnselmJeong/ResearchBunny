import type { OpenAlex } from "../providers/openalex";
import { fetchPubMedByIds } from "../search/pubmed-search";
import type { FetchLike } from "../search/web-search";
import { AppError, type Work } from "../../shared/types";
import { normalizeDoi, pmidOf, titleSimilarity } from "../../shared/domain";
import { authorMatches, type ShelfCandidate } from "../../shared/shelf";

/** Fields the app reads from OpenAlex `raw` after a work is built (domain.ts, fulltext/engine.ts). */
const KEEP_RAW = ["id", "ids", "best_oa_location", "locations", "type", "is_retracted"];
/** Keep shelf records small: dropping counts_by_year, concepts, authorships etc. cuts ~90%. */
export function slimRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  for (const key of KEEP_RAW) if (key in raw) slim[key] = raw[key];
  if (Array.isArray(slim.locations))
    slim.locations = (slim.locations as Record<string, unknown>[]).slice(0, 8).map((l) => ({
      pdf_url: l?.pdf_url ?? null,
      landing_page_url: l?.landing_page_url ?? null,
      is_oa: l?.is_oa ?? null,
      version: l?.version ?? null,
    }));
  return slim;
}

export interface ResolveInput {
  fileId: string;
  title: string;
  year: number | null;
  firstAuthor?: string;
  dois: string[];
}
export type Resolution =
  | { kind: "accept"; work: Work; method: "doi" | "title"; similarity: number; doi?: string }
  | { kind: "review"; candidates: ShelfCandidate[]; note: string }
  | { kind: "none"; candidates: ShelfCandidate[]; note: string };

const usableDoi = (doi: string) => doi.length < 200 && !/[\s,|]/.test(doi);
const candidate = (work: Work, similarity: number): ShelfCandidate => ({
  openalex: work.openalex || "",
  title: work.title,
  authors: work.authors.slice(0, 6),
  year: work.year,
  doi: work.doi,
  venue: work.venue,
  similarity: Math.round(similarity * 1000) / 1000,
});
export function searchText(title: string) {
  // Lowercase so title words such as AND/OR/NOT are not read as search operators.
  return title.toLowerCase().replace(/["*()[\]{}:;!?\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

/** Share of the daily OpenAlex credits kept for the user's own searches. */
export const SHELF_RESERVE = 0.2;
export class ShelfResolver {
  constructor(
    private oa: OpenAlex,
    private pubmedKey: () => string | undefined,
    private fetcher: FetchLike = fetch,
  ) {}

  /**
   * Background indexing must not spend the budget interactive searches need:
   * stop while the reported balance is under the reserve and resume after reset.
   */
  private reserve(cost: number) {
    const rate = this.oa.rateLimit;
    if (!rate || rate.resetAt <= Date.now()) return;
    if (rate.remaining - cost < Math.max(rate.limit * SHELF_RESERVE, 20))
      throw Object.assign(new AppError("SHELF_RESERVE", "OpenAlex 일일 예산의 남은 몫은 검색용으로 남겨 둡니다.", true), { resetMs: rate.resetAt - Date.now() });
  }
  /** Look up every DOI candidate in batches of 50 with one `filter=doi:a|b|…` call each. */
  async byDoi(dois: string[], signal: AbortSignal, onCall: () => void): Promise<Map<string, Work>> {
    const found = new Map<string, Work>();
    const unique = [...new Set(dois.map(normalizeDoi).filter((d): d is string => !!d && usableDoi(d)))];
    for (let i = 0; i < unique.length; i += 50) {
      signal.throwIfAborted();
      const chunk = unique.slice(i, i + 50);
      this.reserve(1);
      try {
        const page = await this.oa.page({ filter: `doi:${chunk.join("|")}`, per_page: "50" }, signal, onCall);
        for (const work of page.works) if (work.doi) found.set(work.doi, work);
      } catch (error) {
        // A malformed DOI can fail a whole batch; title search still covers those files.
        if (signal.aborted || !(error instanceof AppError) || !["PROVIDER", "PROVIDER_SCHEMA", "NOT_FOUND"].includes(error.code)) throw error;
      }
    }
    return found;
  }

  async byTitle(input: ResolveInput, signal: AbortSignal, onCall: () => void): Promise<Resolution> {
    const query = searchText(input.title);
    if (query.length < 12) return { kind: "none", candidates: [], note: "제목이 짧아 검색하지 않음" };
    this.reserve(10);
    const page = await this.oa.page(
      {
        search: query,
        per_page: "5",
        ...(input.year ? { filter: `publication_year:${input.year - 1}-${input.year + 1}` } : {}),
      },
      signal,
      onCall,
    );
    const ranked = page.works
      .map((work) => ({ work, similarity: titleSimilarity(work.title, input.title) }))
      .sort((a, b) => b.similarity - a.similarity);
    const best = ranked[0];
    const candidates = ranked.slice(0, 3).filter((r) => r.similarity >= 0.4).map((r) => candidate(r.work, r.similarity));
    if (!best) return { kind: "none", candidates, note: "제목 검색 결과 없음" };
    const author = input.firstAuthor ? authorMatches(input.firstAuthor, best.work.authors[0]) : null;
    if (best.similarity >= 0.9 && (author === true || (author === null && best.similarity >= 0.97)))
      return { kind: "accept", work: best.work, method: "title", similarity: best.similarity };
    if (best.similarity >= 0.75)
      return { kind: "review", candidates, note: best.similarity >= 0.9 ? "제목은 일치하지만 첫 저자가 다름" : "제목 유사도 0.75–0.9" };
    return { kind: "none", candidates, note: "일치하는 서지를 찾지 못함" };
  }

  /**
   * Resolve files: DOI candidates (only when the OpenAlex title matches the
   * filename title, which filters citation DOIs printed on page 1), then title
   * search. Returns one resolution per input.
   */
  async resolve(inputs: ResolveInput[], signal: AbortSignal, onCall: () => void): Promise<Map<string, Resolution>> {
    const result = new Map<string, Resolution>();
    const byDoi = await this.byDoi(inputs.flatMap((i) => i.dois), signal, onCall);
    for (const input of inputs) {
      signal.throwIfAborted();
      const options = input.dois
        .map(normalizeDoi)
        .map((doi) => (doi ? byDoi.get(doi) : undefined))
        .filter((w): w is Work => !!w)
        .map((work) => ({ work, similarity: input.title ? titleSimilarity(work.title, input.title) : 0 }))
        .sort((a, b) => b.similarity - a.similarity);
      if (options[0] && options[0].similarity >= 0.5) {
        result.set(input.fileId, { kind: "accept", work: options[0].work, method: "doi", similarity: options[0].similarity, doi: options[0].work.doi || undefined });
        continue;
      }
      try {
        result.set(input.fileId, await this.byTitle(input, signal, onCall));
      } catch (error) {
        // One unusual record must not stop the batch; budget and network errors still do,
        // but the lookups already paid for are kept.
        if (signal.aborted || !(error instanceof AppError) || !["PROVIDER", "PROVIDER_SCHEMA", "NOT_FOUND"].includes(error.code))
          throw Object.assign(error as object, { partial: result });
        result.set(input.fileId, { kind: "none", candidates: [], note: "제목 검색 응답을 해석하지 못함" });
      }
    }
    await this.abstracts(
      [...result.values()].flatMap((r) => (r.kind === "accept" && !r.work.abstract && pmidOf(r.work) ? [r.work] : [])),
      signal,
    );
    return result;
  }

  /** Fill missing OpenAlex abstracts from PubMed `efetch`, 50 PMIDs per request. */
  async abstracts(works: Work[], signal: AbortSignal) {
    const byPmid = new Map(works.map((w) => [pmidOf(w)!, w]));
    const ids = [...byPmid.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      signal.throwIfAborted();
      try {
        const results = await fetchPubMedByIds(ids.slice(i, i + 50), 50, { apiKey: this.pubmedKey(), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), fetchFn: this.fetcher });
        for (const r of results) {
          const abstract = r.content.match(/\nAbstract: ([\s\S]+)$/)?.[1]?.trim();
          const work = r.pmid ? byPmid.get(r.pmid) : undefined;
          if (work && abstract) {
            work.abstract = abstract;
            work.raw = { ...work.raw, abstractSource: "pubmed" };
          }
        }
      } catch {
        signal.throwIfAborted();
        // PubMed is an optional supplement; keep the OpenAlex record without it.
      }
    }
  }
}
