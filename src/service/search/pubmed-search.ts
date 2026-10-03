// Adapted from ResearchBunny: app-owned scholarly retrieval.
import type { FetchLike, WebSearchResult } from "./web-search";

const EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const USER_AGENT = "ResearchBunny/1.0 (PubMed research assistant)";

export interface PubMedRequestOptions {
  apiKey?: string;
  signal?: AbortSignal;
  fetchFn?: FetchLike;
}

// NCBI permits 3 requests/sec without a key, 10/sec with one. Serialize slots
// across sidebar conversations; no credentials or query strings enter logs.
let requestQueue = Promise.resolve();
let nextRequestAt = 0;
async function reserveRequest(options: PubMedRequestOptions) {
  let release!: () => void;
  const previous = requestQueue;
  requestQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    options.signal?.throwIfAborted();
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(options.signal?.reason); };
      const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolve(); }, delay);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    options.signal?.throwIfAborted();
    nextRequestAt = Date.now() + (options.apiKey ? 110 : 350);
  } finally { release(); }
}

function addApiKey(params: URLSearchParams, apiKey?: string): void {
  const normalizedApiKey = apiKey?.trim();
  if (normalizedApiKey) params.set("api_key", normalizedApiKey);
}

export function broadenPubMedQuery(query: string): string {
  return query
    .replace(/\b(?:systematic\s+review|meta-analysis|randomi[sz]ed\s+(?:controlled\s+)?trial|peer-reviewed|research\s+article|review\s+article)\b/gi, " ")
    .replace(/\b(?:literature|research|studies|study|review)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function extractAbstract(xml: string): string {
  const parts = Array.from(xml.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/gi));
  return parts
    .map((match) => {
      const label = match[1].match(/\bLabel="([^"]+)"/i)?.[1];
      const text = decodeXml(match[2]);
      return text ? `${label ? `${decodeXml(label)}: ` : ""}${text}` : "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractAuthors(xml: string): string[] {
  return Array.from(xml.matchAll(/<Author(?:\s[^>]*)?>([\s\S]*?)<\/Author>/gi))
    .map((match) => {
      const block = match[1];
      const collective = firstTag(block, "CollectiveName");
      if (collective) return collective;
      const lastName = firstTag(block, "LastName");
      const foreName = firstTag(block, "ForeName") || firstTag(block, "Initials");
      return [lastName, foreName].filter(Boolean).join(", ");
    })
    .filter(Boolean);
}

function extractDoi(xml: string): string {
  const articleId = xml.match(/<ArticleId\s+[^>]*IdType="doi"[^>]*>([\s\S]*?)<\/ArticleId>/i);
  const electronicId = xml.match(/<ELocationID\s+[^>]*EIdType="doi"[^>]*>([\s\S]*?)<\/ELocationID>/i);
  return decodeXml(articleId?.[1] ?? electronicId?.[1] ?? "");
}

export function parsePubMedXml(xml: string): WebSearchResult[] {
  return Array.from(xml.matchAll(/<PubmedArticle(?:\s[^>]*)?>([\s\S]*?)<\/PubmedArticle>/gi))
    .map((match): WebSearchResult | null => {
      const article = match[1];
      const pmid = firstTag(article, "PMID");
      const title = firstTag(article, "ArticleTitle");
      if (!pmid || !title) return null;

      const authors = extractAuthors(article);
      const journal = firstTag(article, "Title");
      const year = firstTag(article, "Year") || firstTag(article, "MedlineDate");
      const doi = extractDoi(article);
      const abstract = extractAbstract(article);
      const citation = [authors.slice(0, 4).join("; "), year, journal]
        .filter(Boolean)
        .join(". ");
      const details = [
        `Source: PubMed (PMID ${pmid})`,
        citation,
        doi ? `DOI: ${doi}` : "",
        abstract ? `Abstract: ${abstract}` : "Abstract unavailable in PubMed.",
      ].filter(Boolean).join("\n");

      return {
        title,
        url: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`,
        content: details,
        source: "pubmed",
        pmid,
        doi: doi || undefined,
      } satisfies WebSearchResult;
    })
    .filter((result): result is WebSearchResult => result !== null);
}

async function requestPubMedIds(
  query: string,
  maxResults: number,
  options: PubMedRequestOptions = {},
): Promise<string[]> {
  const params = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmode: "json",
    retmax: String(Math.max(1, Math.min(10, maxResults))),
    sort: "relevance",
    tool: "ResearchBunny",
  });
  addApiKey(params, options.apiKey);
  await reserveRequest(options);
  const response = await (options.fetchFn ?? fetch)(`${EUTILS_BASE}/esearch.fcgi?${params}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`PubMed search error: HTTP ${response.status}`);
  const payload = await response.json() as { esearchresult?: { idlist?: string[] } };
  return payload.esearchresult?.idlist?.filter(Boolean) ?? [];
}

export async function searchPubMedIds(
  query: string,
  maxResults = 5,
  options: PubMedRequestOptions = {},
): Promise<string[]> {
  let ids = await requestPubMedIds(query, maxResults, options);
  if (ids.length === 0) {
    const broaderQuery = broadenPubMedQuery(query);
    if (broaderQuery && broaderQuery !== query.trim()) {
      ids = await requestPubMedIds(broaderQuery, maxResults, options);
    }
  }
  return ids;
}

export async function searchPubMed(
  query: string,
  maxResults = 5,
  options: PubMedRequestOptions = {},
): Promise<WebSearchResult[]> {
  const ids = await searchPubMedIds(query, maxResults, options);
  if (ids.length === 0) return [];

  return fetchPubMedByIds(ids, maxResults, options);
}

export async function fetchPubMedByIds(
  ids: string[],
  maxResults = ids.length,
  options: PubMedRequestOptions = {},
): Promise<WebSearchResult[]> {
  const normalizedIds = Array.from(new Set(
    ids.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)),
  )).slice(0, 50);
  if (normalizedIds.length === 0) return [];

  const params = new URLSearchParams({
    db: "pubmed",
    id: normalizedIds.join(","),
    rettype: "abstract",
    retmode: "xml",
    tool: "ResearchBunny",
  });
  addApiKey(params, options.apiKey);
  await reserveRequest(options);
  const response = await (options.fetchFn ?? fetch)(`${EUTILS_BASE}/efetch.fcgi?${params}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`PubMed fetch error: HTTP ${response.status}`);
  return parsePubMedXml(await response.text()).slice(0, maxResults);
}
