// Shelf ("서고"): an app-wide PDF library kept outside projects. Indexing never
// changes the folder; only an approved inbox sort (수신함 정리) moves PDFs.
export const DEFAULT_SHELF_EXCLUDE = ["_system", "_news", "_to_delete", "_duplicated", "_summaries"];
export const DEFAULT_EMBED_MODEL = "embeddinggemma-2:latest";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
/** Scope ids for the shelf list besides real folder ids. */
export const SHELF_ALL = "all";
export const SHELF_INBOX = "inbox";
export const SHELF_REVIEW = "review";
/** Sort destinations besides taxonomy leaves, named as `_system/intake.py` names them. */
export const SHELF_UNCATEGORIZED = "_uncategorized";
export const SHELF_DUPLICATED = "_duplicated";
/** The inbox is the shelf root plus `_uncategorized`. */
export const isInboxFolder = (relPath: string) =>
  relPath === "" || relPath === SHELF_UNCATEGORIZED || relPath.startsWith(SHELF_UNCATEGORIZED + "/");

export interface ShelfSortLeaf {
  /** Folder path relative to the shelf root, e.g. `01 Psychiatric Disorders/Mood Disorders - Clinical`. */
  path: string;
  domain: string;
  name: string;
  def: string;
}
export interface ShelfSortVote {
  path: string;
  /** Share of the similarity-weighted neighbour vote, 0–1. */
  share: number;
  /** Cosine similarity of the closest neighbour in that folder. */
  similarity: number;
}
export interface ShelfSortItem {
  fileId: string;
  relPath: string;
  /** Current folder: "" for the root or an `_uncategorized` path. */
  folder: string;
  title: string;
  year: number | null;
  authors: string[];
  /** Proposed destination: a leaf path, `_uncategorized`, `_duplicated`, or null to leave the file. */
  target: string | null;
  /** ai: AI decision on embedding candidates; duplicate/version: an existing copy decided it; embedding: AI unavailable. */
  source: "ai" | "duplicate" | "version" | "embedding";
  confidence: "high" | "medium" | "low" | null;
  reason: string;
  votes: ShelfSortVote[];
  /** Whether the AI chose the folder the neighbour vote ranked first; null without both. */
  agree: boolean | null;
  /** Library copy behind a duplicate or version decision. */
  existing?: string;
}
export interface ShelfSortJob {
  status: "idle" | "running" | "ready" | "failed" | "cancelled";
  message: string;
  done?: number;
  total?: number;
  updatedAt: string;
}
export interface ShelfSortState {
  job: ShelfSortJob;
  createdAt: string | null;
  /** file: `_system/taxonomy.json`; folders: leaf folders of the shelf tree. */
  taxonomy: "file" | "folders" | null;
  leaves: ShelfSortLeaf[];
  items: ShelfSortItem[];
  /** Inbox PDFs not indexed far enough to judge yet. */
  waiting: { fileId: string; relPath: string; reason: string }[];
  /** `_system` exists, so moves go to move_log.jsonl and logs/, and index.json is rebuilt. */
  ledger: boolean;
}
export interface ShelfSortResult {
  moved: number;
  uncategorized: number;
  duplicated: number;
  skipped: { relPath: string; reason: string }[];
}

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
    method: "hash" | "doi" | "title" | "manual" | "provisional";
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
  config: ShelfConfig | null;
  ollama: OllamaStatus;
  failures: { fileId: string; path: string; reason: string }[];
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
  const match = base.match(/^(\d{4})\s+-\s+(.+?)\s+-\s+(.+)$/);
  if (!match) return null;
  const year = Number(match[1]);
  const authors = match[2]
    .replace(/,?\s*et\s+al\.?$/i, "")
    .split(/\s*(?:,|;|&|\band\b)\s*/i)
    .map((a) => a.trim())
    .filter((a) => a && !/^et\s+al\.?$/i.test(a));
  return { year: year >= 1500 && year <= 2200 ? year : null, authors, title: match[3].trim() };
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
