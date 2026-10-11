// Shelf ("서고"): the app-wide PDF library kept outside projects. Indexing is
// read-only; the app's own downloads and imports are added to the root (inbox).
export const DEFAULT_SHELF_EXCLUDE = ["_system", "_news", "_to_delete", "_duplicated", "_summaries"];
export const DEFAULT_EMBED_MODEL = "embeddinggemma-2:latest";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
/** Scope ids for the shelf list besides real folder ids. */
export const SHELF_ALL = "all";
export const SHELF_INBOX = "inbox";
export const SHELF_REVIEW = "review";

// Retrieval prompts from the EmbeddingGemma 2 model card
// (ai.google.dev/gemma/docs/embeddinggemma/model_card_2): documents use
// `title: {title} | text: {content}` with `title: none` when untitled, queries use
// `task: search result | query: {query}`. Bump `version` when this changes so
// every stored vector is rebuilt.
export const EMBED_PROMPTS = {
  version: "eg2-v1",
  document: (title: string, text: string) => `title: ${title.trim() || "none"} | text: ${text.trim()}`,
  query: (q: string) => `task: search result | query: ${q.trim()}`,
};

export type ShelfStage = "found" | "hashed" | "extracted" | "resolved";
export type ShelfStatus = "ok" | "review" | "provisional" | "auxiliary" | "failed" | "missing";
export type EmbedBasis = "abstract" | "pdf-abstract" | "page1" | "title";

export interface ShelfCandidate {
  openalex: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  venue: string;
  similarity: number;
}
export interface ShelfFileInfo {
  parsed?: ParsedFilename | null;
  metadataTitle?: string;
  dois?: string[];
  page1?: string;
  abstract?: string;
  pages?: number | null;
  extraction?: string;
  resolution?: {
    /** `app`: downloaded or imported by the app and stored in the inbox for this work. */
    method: "hash" | "app" | "doi" | "title" | "manual" | "provisional";
    similarity?: number;
    doi?: string;
    note?: string;
    at: string;
  };
  candidates?: ShelfCandidate[];
  duplicateOf?: string;
  error?: string;
}
export interface ShelfFolderNode {
  id: string;
  parentId: string | null;
  name: string;
  relPath: string;
  count: number;
}
export interface ShelfIndexCounts {
  files: number;
  works: number;
  stages: Record<ShelfStage, number>;
  statuses: Record<ShelfStatus, number>;
  embedded: number;
  embeddable: number;
}
export interface ShelfJob {
  state: "idle" | "scanning" | "indexing" | "paused" | "offline" | "confirm";
  message: string;
  phase?: string;
  done?: number;
  total?: number;
  resolverPausedUntil?: string;
  embeddingPaused?: string;
  confirm?: { missing: number; total: number };
  updatedAt: string;
}
export interface ShelfSummary {
  configured: boolean;
  root: { id: string; path: string; name: string; lastScanAt: string | null } | null;
  online: boolean;
  folders: ShelfFolderNode[];
  inbox: number;
  review: number;
  total: number;
  counts: ShelfIndexCounts;
  job: ShelfJob;
}
export interface ShelfConfig {
  path: string;
  exclude: string[];
  model: string;
  ollamaUrl: string;
}
export interface OllamaStatus {
  running: boolean;
  url: string;
  loopback: boolean;
  version?: string;
  models: { name: string; digest: string }[];
  modelInstalled: boolean;
  modelKey?: string;
  error?: string;
}
export interface ShelfStatusResult {
  summary: ShelfSummary;
  /** PDFs still kept in the app's own folder, which can be moved into the inbox. */
  managed: number;
  config: ShelfConfig | null;
  ollama: OllamaStatus;
  failures: { fileId: string; path: string; reason: string }[];
}
export interface ShelfAdoptResult {
  moved: number;
  linked: number;
  /** Papers the shelf already holds as another file; their app copies stay. */
  kept: string[];
  failed: { workId: string; reason: string }[];
}
export interface ShelfRelatedItem {
  workId: string;
  title: string;
  authors: string[];
  year: number | null;
  folder: string;
  score: number;
  lowConfidence: boolean;
}
export interface ShelfRelated {
  similar: ShelfRelatedItem[];
  cites: ShelfRelatedItem[];
  citedBy: ShelfRelatedItem[];
  semantic: boolean;
  notice: string;
  basis: EmbedBasis | null;
}
export interface ShelfHit {
  workId: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  folderId: string;
  folder: string;
}
export interface ShelfSearchResult {
  hits: ShelfHit[];
  semantic: boolean;
}

export interface ParsedFilename {
  year: number | null;
  authors: string[];
  title: string;
}
/** Parse the library's `연도 - 저자 - 제목.pdf` naming convention. */
export function parseShelfFilename(name: string): ParsedFilename | null {
  const base = name.replace(/\.pdf$/i, "").normalize("NFC").trim();
  const match = base.match(/^(\d{4}|n\.d\.)\s+-\s+(.+?)\s+-\s+(.+)$/i);
  if (!match) return null;
  const year = Number(match[1]);
  const authors = match[2]
    .replace(/,?\s*et\s+al\.?$/i, "")
    .split(/\s*(?:,|;|&|\band\b)\s*/i)
    .map((a) => a.trim())
    .filter((a) => a && !/^et\s+al\.?$/i.test(a) && !/^unknown$/i.test(a));
  return { year: year >= 1500 && year <= 2200 ? year : null, authors, title: match[3].trim() };
}

/**
 * Last word of the family name from "Given Family" (OpenAlex) or "Family, Given"
 * (PubMed, BibTeX). The shelf drops particles ("van der Wal" → "Wal", 86 of 109
 * names) and writes all-caps names in title case.
 */
export function familyName(name: string): string {
  const clean = name.normalize("NFC").replace(/\s+/g, " ").trim();
  const family = clean.includes(",") ? clean.split(",")[0].trim() : clean;
  const last = family.split(" ").filter((t) => !/^(?:jr|sr|ii|iii|iv)\.?$/i.test(t)).pop() || "";
  return /\p{Ll}/u.test(last) || last.length < 2 ? last : last.toLowerCase().replace(/(^|[-‐'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}
/** Long shelf names are cut at a word and end in " ...", 240 bytes in all. */
const MAX_FILENAME_BYTES = 240;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
/**
 * The shelf's `연도 - 저자 - 제목.pdf` name (inverse of parseShelfFilename):
 * one author `Kim`, two `Kim, Lee`, more `Kim et al.`; ':' becomes ';' and
 * characters that are unsafe in file names are dropped.
 */
export function formatShelfFilename(work: { year: number | null; authors: string[]; title: string }): string {
  const names = work.authors.map(familyName).filter(Boolean);
  const authors = names.length === 0 ? "Unknown" : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]}, ${names[1]}` : `${names[0]} et al.`;
  const clean = (text: string) => text.normalize("NFC").replace(/<[^>]+>/g, "").replace(/\s*:\s*/g, "; ").replace(/[?*"<>|\\/]|\p{Cc}/gu, "").replace(/\s+/g, " ").trim();
  const head = `${work.year ?? "n.d."} - ${clean(authors)} - `;
  let title = clean(work.title).replace(/[.\s]+$/, "") || "Untitled";
  if (bytes(head + title + ".pdf") > MAX_FILENAME_BYTES) {
    const room = MAX_FILENAME_BYTES - bytes(head + " ....pdf");
    let cut = "";
    for (const char of title) {
      if (bytes(cut + char) > room) break;
      cut += char;
    }
    title = `${cut.replace(/\s+\S*$/, "").trim() || cut.trim()} ...`;
  }
  return `${head}${title}.pdf`;
}

/** Accent- and case-insensitive surname token for first-author checks. */
export function surnameKey(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ").trim();
}
export function authorMatches(filenameAuthor: string | undefined, providerAuthor: string | undefined): boolean {
  if (!filenameAuthor || !providerAuthor) return false;
  const wanted = surnameKey(filenameAuthor).split(/\s+/)[0];
  if (!wanted) return false;
  const tokens = surnameKey(providerAuthor).split(/[\s]+/);
  return tokens.includes(wanted) || tokens.some((t) => t.split("-").includes(wanted)) || wanted.split("-").some((part) => tokens.includes(part));
}

/** Exact title key: filenames drop ':' '?' '/' etc., so compare letters and digits only. */
export function titleKey(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Take the text after an "Abstract"/"Summary" heading up to the first
 * Introduction/Keywords/"1." marker. Accept only 300–3,000 characters.
 */
export function extractAbstractCandidate(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  const start = flat.search(/\b(?:abstract|summary)\b\s*[:.\-—–]?\s*/i);
  if (start < 0) return null;
  const head = flat.slice(start).match(/^(?:abstract|summary)\b\s*[:.\-—–]?\s*/i)!;
  const body = flat.slice(start + head[0].length);
  const end = body.search(/\b(?:introduction|keywords?\s*[:.]|key\s+words\s*[:.]|background\s*[:.]?\s+[A-Z])|(?:^|\s)1\.?\s+(?:introduction|background)\b|(?:^|\s)1\.\s+[A-Z]/i);
  const abstract = (end >= 0 ? body.slice(0, end) : body.slice(0, 3200)).trim();
  return abstract.length >= 300 && abstract.length <= 3000 ? abstract : null;
}

/** First-page text without running heads, URLs and DOIs; used when no abstract exists. */
export function pageLead(text: string, length = 1500): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(?:doi|https?):?\s*10\.\d{4,9}\/\S+/gi, " ")
    .replace(/\b(?:received|accepted|published online|copyright|©|all rights reserved)[^.]{0,160}\./gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}
