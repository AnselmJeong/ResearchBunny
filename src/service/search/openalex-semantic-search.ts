// Adapted from ScholarPen: app-owned scholarly retrieval.
function reconstructOpenAlexAbstract(index?: Record<string, number[]> | null): string {
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index ?? {})) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (Number.isInteger(position) && position >= 0 && position < 20000) words[position] = word;
  }
  return words.join(" ");
}
import type { FetchLike, WebSearchResult } from "./web-search";

const OPENALEX_WORKS_URL = "https://api.openalex.org/works";
const MAX_SEMANTIC_QUERY_LENGTH = 2_000;
const SEMANTIC_REQUEST_INTERVAL_MS = 1_000;
let lastSemanticRequestAt = 0;
let semanticRequestQueue = Promise.resolve();

interface OpenAlexSemanticWork {
  id?: string;
  title?: string;
  doi?: string;
  ids?: { pmid?: string };
  publication_year?: number;
  relevance_score?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { source?: { display_name?: string } };
}

interface OpenAlexSemanticResponse {
  results?: OpenAlexSemanticWork[];
}

function normalizeDoi(value: string | undefined): string | undefined {
  const doi = (value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  return doi || undefined;
}

function normalizePmid(value: string | undefined): string | undefined {
  const pmid = value?.match(/(?:pubmed\.ncbi\.nlm\.nih\.gov\/)?(\d+)\/?$/i)?.[1];
  return pmid || undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("OpenAlex semantic search was cancelled.", "AbortError"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function reserveSemanticRequestSlot(signal?: AbortSignal): Promise<void> {
  let releaseQueue!: () => void;
  const previousRequest = semanticRequestQueue;
  semanticRequestQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previousRequest;
  try {
    if (signal?.aborted) {
      throw new DOMException("OpenAlex semantic search was cancelled.", "AbortError");
    }
    const waitMs = Math.max(
      0,
      lastSemanticRequestAt + SEMANTIC_REQUEST_INTERVAL_MS - Date.now(),
    );
    await abortableDelay(waitMs, signal);
    lastSemanticRequestAt = Date.now();
  } finally {
    releaseQueue();
  }
}

export function parseOpenAlexSemanticResults(
  payload: OpenAlexSemanticResponse,
): WebSearchResult[] {
  return (payload.results ?? []).flatMap((work) => {
    const title = work.title?.trim();
    const openAlexUrl = work.id?.trim();
    if (!title || !openAlexUrl) return [];

    const doi = normalizeDoi(work.doi);
    const pmid = normalizePmid(work.ids?.pmid);
    const authors = (work.authorships ?? [])
      .map((authorship) => authorship.author?.display_name?.trim())
      .filter((author): author is string => Boolean(author));
    const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
    const citation = [
      authors.slice(0, 4).join("; "),
      work.publication_year ? String(work.publication_year) : "",
      work.primary_location?.source?.display_name?.trim() ?? "",
    ].filter(Boolean).join(". ");
    const content = [
      "Source: OpenAlex semantic search",
      citation,
      doi ? `DOI: ${doi}` : "",
      pmid ? `PMID: ${pmid}` : "",
      abstract ? `Abstract: ${abstract}` : "Abstract unavailable in OpenAlex.",
    ].filter(Boolean).join("\n");

    return [{
      title,
      url: pmid
        ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`
        : doi
          ? `https://doi.org/${encodeURIComponent(doi)}`
          : openAlexUrl,
      content,
      source: "openalex-semantic",
      pmid,
      doi,
      relevanceScore: work.relevance_score,
    } satisfies WebSearchResult];
  });
}

export async function searchOpenAlexSemantic(
  query: string,
  maxResults = 12,
  apiKey?: string,
  signal?: AbortSignal,
  fetchFn: FetchLike = fetch,
): Promise<WebSearchResult[]> {
  const semanticQuery = query.replace(/\s+/g, " ").trim().slice(0, MAX_SEMANTIC_QUERY_LENGTH);
  if (!semanticQuery) return [];

  const params = new URLSearchParams({
    "search.semantic": semanticQuery,
    "per-page": String(Math.max(1, Math.min(50, maxResults))),
    select: [
      "id",
      "title",
      "doi",
      "ids",
      "publication_year",
      "relevance_score",
      "abstract_inverted_index",
      "authorships",
      "primary_location",
    ].join(","),
  });
  const key = apiKey?.trim();
  await reserveSemanticRequestSlot(signal);
  const response = await fetchFn(`${OPENALEX_WORKS_URL}?${params}`, {
    headers: {
      Accept: "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenAlex semantic search error: HTTP ${response.status}`);
  }
  return parseOpenAlexSemanticResults(await response.json() as OpenAlexSemanticResponse);
}
