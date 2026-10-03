// Adapted from ScholarPen: app-owned scholarly retrieval.
import { searchOpenAlexSemantic } from "./openalex-semantic-search";
import { fetchPubMedByIds, searchPubMedIds } from "./pubmed-search";
import type { FetchLike, WebSearchResult } from "./web-search";

function normalizedIdentity(result: WebSearchResult): string {
  if (result.pmid) return `pmid:${result.pmid}`;
  if (result.doi) return `doi:${result.doi.toLowerCase()}`;
  return `title:${result.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
}

function preferRicherResult(
  current: WebSearchResult,
  candidate: WebSearchResult,
): WebSearchResult {
  if (candidate.source === "pubmed" && current.source !== "pubmed") return candidate;
  return candidate.content.length > current.content.length ? candidate : current;
}

export function mergeScholarlyResults(
  semanticResults: WebSearchResult[],
  pubMedResults: WebSearchResult[],
  maxResults: number,
): WebSearchResult[] {
  const ranked = new Map<string, {
    result: WebSearchResult;
    score: number;
    firstSeen: number;
  }>();
  let firstSeen = 0;

  for (const results of [semanticResults, pubMedResults]) {
    results.forEach((result, index) => {
      const identity = normalizedIdentity(result);
      const reciprocalRankScore = 1 / (60 + index + 1);
      const existing = ranked.get(identity);
      if (existing) {
        existing.score += reciprocalRankScore;
        existing.result = preferRicherResult(existing.result, result);
      } else {
        ranked.set(identity, {
          result,
          score: reciprocalRankScore,
          firstSeen: firstSeen++,
        });
      }
    });
  }

  return Array.from(ranked.values())
    .sort((left, right) => right.score - left.score || left.firstSeen - right.firstSeen)
    .slice(0, Math.max(1, maxResults))
    .map(({ result }) => result);
}

export async function searchScholarlyEvidence(
  query: string,
  maxResults = 5,
  options: {
    openAlexApiKey?: string;
    ncbiApiKey?: string;
    signal?: AbortSignal;
    fetchFn?: FetchLike;
    onWarning?: (message: string) => void;
  } = {},
): Promise<WebSearchResult[]> {
  const [semanticAttempt, pubMedIdAttempt] = await Promise.allSettled([
    searchOpenAlexSemantic(
      query,
      Math.max(maxResults * 2, 10),
      options.openAlexApiKey,
      options.signal,
      options.fetchFn,
    ),
    searchPubMedIds(query, Math.max(maxResults, 8), {
      apiKey: options.ncbiApiKey,
      signal: options.signal,
      fetchFn: options.fetchFn,
    }),
  ]);

  if (semanticAttempt.status === "rejected") {
    if ((semanticAttempt.reason as Error)?.name === "AbortError") throw semanticAttempt.reason;
    options.onWarning?.("OpenAlex 조회 실패");
  }
  if (pubMedIdAttempt.status === "rejected") {
    if ((pubMedIdAttempt.reason as Error)?.name === "AbortError") throw pubMedIdAttempt.reason;
    options.onWarning?.("PubMed 조회 실패");
  }
  if (semanticAttempt.status === "rejected" && pubMedIdAttempt.status === "rejected") {
    throw new Error("Both OpenAlex semantic search and PubMed search failed.");
  }

  let semanticResults = semanticAttempt.status === "fulfilled" ? semanticAttempt.value : [];
  const pubMedIds = pubMedIdAttempt.status === "fulfilled" ? pubMedIdAttempt.value : [];
  const semanticPmids = semanticResults.flatMap((result) => result.pmid ? [result.pmid] : []);
  const idsToFetch = Array.from(new Set([...semanticPmids, ...pubMedIds]));
  let pubMedResults: WebSearchResult[] = [];

  if (idsToFetch.length > 0) {
    try {
      const verified = await fetchPubMedByIds(idsToFetch, idsToFetch.length, {
        apiKey: options.ncbiApiKey,
        signal: options.signal,
      fetchFn: options.fetchFn,
      });
      const verifiedByPmid = new Map(verified.flatMap((result) => (
        result.pmid ? [[result.pmid, result] as const] : []
      )));
      semanticResults = semanticResults.map((result) => {
        const pubMedResult = result.pmid ? verifiedByPmid.get(result.pmid) : undefined;
        return pubMedResult
          ? { ...pubMedResult, content: `${pubMedResult.content}\nDiscovery: OpenAlex semantic search` }
          : result;
      });
      pubMedResults = pubMedIds.flatMap((pmid) => {
        const result = verifiedByPmid.get(pmid);
        return result ? [result] : [];
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      options.onWarning?.("PubMed 초록 조회 실패");
      if (semanticResults.length === 0) throw error;
    }
  }

  return mergeScholarlyResults(semanticResults, pubMedResults, maxResults);
}
