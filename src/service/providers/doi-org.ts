import { version } from "../../../package.json";
import { AppError, type Work } from "../../shared/types";
import { blankWork, normalizeDoi, safeWebUrl } from "../../shared/domain";
import type { FetchLike } from "../search/web-search";

// doi.org passes each DOI to its registration agency (Crossref, DataCite with arXiv,
// mEDRA, JaLC, KISTI), which answers in CSL JSON from the day the DOI is registered.
// OpenAlex indexes new papers days or weeks later, so manual lookups fall back here.

const TYPES: Record<string, string> = {
  "journal-article": "article",
  "article-journal": "article",
  "posted-content": "preprint",
  "proceedings-article": "article",
  "paper-conference": "article",
  "book-chapter": "book-chapter",
  chapter: "book-chapter",
  book: "book",
  report: "report",
  thesis: "dissertation",
  dataset: "dataset",
};
const first = (value: unknown): string => String((Array.isArray(value) ? value[0] : value) ?? "").trim();
const yearOf = (date: unknown): number | null => {
  const year = (date as { "date-parts"?: unknown[][] } | undefined)?.["date-parts"]?.[0]?.[0];
  return Number.isInteger(year) ? (year as number) : null;
};
/** Crossref abstracts are JATS XML; keep the text. */
function plainAbstract(value: unknown): string | null {
  const text = first(value)
    .replace(/<jats:title>[\s\S]*?<\/jats:title>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

export function fromCsl(csl: Record<string, unknown>): Work {
  const doi = normalizeDoi(csl.DOI);
  const title = first(csl.title);
  if (!doi || !title) throw new AppError("PROVIDER_SCHEMA", "doi.org 서지를 해석하지 못했습니다.");
  const arxiv = doi.startsWith("10.48550/arxiv.");
  const abstract = plainAbstract(csl.abstract);
  const authors = (Array.isArray(csl.author) ? csl.author : []) as { given?: string; family?: string; literal?: string; name?: string }[];
  return blankWork({
    doi,
    title,
    authors: authors.map((a) => a.literal || a.name || [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
    year: yearOf(csl.issued) ?? yearOf(csl.published) ?? yearOf(csl.created),
    type: arxiv ? "preprint" : TYPES[first(csl.type)] || "article",
    venue: arxiv ? "arXiv" : first(csl["container-title"]),
    abstract,
    volume: first(csl.volume),
    issue: first(csl.issue),
    pages: first(csl.page).replace(/\s*[-–]\s*/, "--"),
    publisher: first(csl.publisher),
    url: safeWebUrl(first(csl.URL) || null) || `https://doi.org/${doi}`,
    source: "doi",
    raw: { registrationAgency: arxiv ? "DataCite" : first(csl.source) || null, ...(abstract ? { abstractSource: "doi" } : {}) },
  });
}

export async function fetchDoiRecord(doi: string, signal: AbortSignal, fetcher: FetchLike = fetch): Promise<Work> {
  const response = await fetcher(`https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { Accept: "application/vnd.citationstyles.csl+json", "User-Agent": `ResearchBunny/${version} (literature discovery desktop app)` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (response.status === 404) throw new AppError("NOT_FOUND", "OpenAlex와 doi.org 모두 이 DOI를 찾지 못했습니다. DOI를 다시 확인하세요.");
  if (!response.ok) throw new AppError("PROVIDER", `doi.org 응답 오류 (${response.status})`, true);
  if (!/json/i.test(response.headers.get("content-type") || ""))
    throw new AppError("PROVIDER_SCHEMA", "이 DOI의 등록 기관이 서지 형식을 제공하지 않습니다.");
  return fromCsl(await response.json() as Record<string, unknown>);
}
