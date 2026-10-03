// Adapted from ScholarPen: app-owned scholarly retrieval.
interface AppSettings { tinyfishApiKey: string; webSearchEnabled: boolean }

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  source?: "pubmed" | "openalex-semantic" | "web";
  pmid?: string;
  doi?: string;
  relevanceScore?: number;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai";

const ACADEMIC_HOST_MARKERS = [
  "doi.org",
  "openalex.org",
  "crossref.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "arxiv.org",
  "semanticscholar.org",
  "jstor.org",
  "projectmuse.jhu.edu",
  "acm.org",
  "ieee.org",
  "springer.com",
  "sciencedirect.com",
  "wiley.com",
  "tandfonline.com",
  "sagepub.com",
  "nature.com",
  "science.org",
  "oup.com",
  "cambridge.org",
  "plos.org",
  "frontiersin.org",
  "bmj.com",
  "mdpi.com",
];

export function academicSourceScore(result: WebSearchResult): number {
  let score = 0;
  try {
    const hostname = new URL(result.url).hostname.toLowerCase();
    if (ACADEMIC_HOST_MARKERS.some((marker) => hostname === marker || hostname.endsWith(`.${marker}`))) {
      score += 100;
    }
    if (hostname.endsWith(".edu") || hostname.endsWith(".ac.uk")) score += 45;
    if (hostname.endsWith(".kr")) score -= 20;
  } catch {
    score -= 10;
  }

  const searchable = `${result.title} ${result.content}`;
  if (/\b(?:doi|journal|abstract|peer-reviewed|systematic review|meta-analysis|research article)\b/i.test(searchable)) {
    score += 20;
  }
  if (/[\u3131-\u318E\uAC00-\uD7A3]/u.test(result.title)) score -= 15;
  return score;
}

export function prioritizeAcademicResults(results: WebSearchResult[]): WebSearchResult[] {
  return results
    .map((result, index) => ({ result, index, score: academicSourceScore(result) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ result }) => result);
}

function authHeaders(apiKey: string, includeContentType = false): HeadersInit {
  return {
    Accept: "application/json",
    ...(includeContentType ? { "Content-Type": "application/json" } : {}),
    "X-API-Key": apiKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return (protocol === "http:" || protocol === "https:") && !new URL(value).username && !new URL(value).password;
  } catch {
    return false;
  }
}

async function assertTinyFishResponse(response: Response, operation: "search" | "fetch"): Promise<void> {
  if (!response.ok) throw new Error(`TinyFish ${operation}: HTTP ${response.status}`);
}

export async function searchWebWithTinyFish(
  query: string,
  settings: AppSettings,
  maxResults = 5,
  signal?: AbortSignal,
  fetchFn: FetchLike = fetch,
): Promise<WebSearchResult[]> {
  const apiKey = settings.tinyfishApiKey.trim();
  const normalizedQuery = query.trim();
  if (!settings.webSearchEnabled || !apiKey || !normalizedQuery) return [];

  const params = new URLSearchParams({ query: normalizedQuery });
  const res = await fetchFn(`${TINYFISH_SEARCH_URL}?${params}`, {
    method: "GET",
    headers: authHeaders(apiKey),
    signal,
  });

  await assertTinyFishResponse(res, "search");
  const json: unknown = await res.json();
  if (!isRecord(json) || !Array.isArray(json.results)) {
    throw new Error("TinyFish search error: invalid response payload.");
  }

  const limit = Math.max(1, Math.min(10, Math.trunc(maxResults)));
  const results: WebSearchResult[] = [];
  for (const candidate of json.results) {
    if (!isRecord(candidate)) continue;
    const title = nonEmptyString(candidate.title);
    const url = nonEmptyString(candidate.url);
    if (!title || !url || !isHttpUrl(url)) continue;
    results.push({
      title,
      url,
      content: nonEmptyString(candidate.snippet) ?? "",
    });
    if (results.length >= limit) break;
  }
  return results;
}

export async function fetchWebPagesWithTinyFish(
  urls: string[],
  settings: AppSettings,
  signal?: AbortSignal,
  fetchFn: FetchLike = fetch,
): Promise<WebSearchResult[]> {
  const apiKey = settings.tinyfishApiKey.trim();
  const safeUrls = [...new Set(urls.filter(isHttpUrl))].slice(0, 10);
  if (!settings.webSearchEnabled || !apiKey || safeUrls.length === 0) return [];

  const res = await fetchFn(TINYFISH_FETCH_URL, {
    method: "POST",
    headers: authHeaders(apiKey, true),
    body: JSON.stringify({
      urls: safeUrls,
      format: "markdown",
      per_url_timeout_ms: 45_000,
    }),
    signal,
  });

  await assertTinyFishResponse(res, "fetch");
  const json: unknown = await res.json();
  if (!isRecord(json) || !Array.isArray(json.results)) {
    throw new Error("TinyFish fetch error: invalid response payload.");
  }

  if (Array.isArray(json.errors)) {
    for (const candidate of json.errors) {
      if (!isRecord(candidate)) continue;
      const failedUrl = nonEmptyString(candidate.url) ?? "unknown URL";
      const error = nonEmptyString(candidate.error) ?? "unknown error";
      console.warn(`[Agent] TinyFish fetch failed for ${failedUrl}: ${error}`);
    }
  }

  return json.results.flatMap((candidate): WebSearchResult[] => {
    if (!isRecord(candidate)) return [];
    const url = nonEmptyString(candidate.url);
    const content = nonEmptyString(candidate.text);
    if (!url || !content || !isHttpUrl(url)) return [];
    return [{
      title: nonEmptyString(candidate.title) ?? url,
      url,
      content,
    }];
  });
}

export async function fetchWebPageWithTinyFish(
  url: string,
  settings: AppSettings,
  signal?: AbortSignal,
  fetchFn: FetchLike = fetch,
): Promise<WebSearchResult | null> {
  return (await fetchWebPagesWithTinyFish([url], settings, signal, fetchFn))[0] ?? null;
}

export async function searchAndFetchWebWithTinyFish(
  query: string,
  settings: AppSettings,
  maxResults = 5,
  signal?: AbortSignal,
  fetchFn: FetchLike = fetch,
): Promise<WebSearchResult[]> {
  const searchResults = prioritizeAcademicResults(
    await searchWebWithTinyFish(
      query,
      settings,
      Math.min(10, Math.max(maxResults, maxResults * 2)),
      signal,
      fetchFn,
    ),
  ).slice(0, maxResults);
  if (searchResults.length === 0) return [];

  let fetched: WebSearchResult[];
  try {
    fetched = await fetchWebPagesWithTinyFish(
      searchResults.map((result) => result.url),
      settings,
      signal,
      fetchFn,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // Search snippets remain usable when page extraction fails.
    return searchResults;
  }
  const fetchedByUrl = new Map(fetched.map((result) => [result.url, result]));

  return searchResults.map((result) => {
    const page = fetchedByUrl.get(result.url);
    return page
      ? { ...result, title: page.title || result.title, content: page.content }
      : result;
  });
}
