// Shelf ("서고"): the app-wide PDF library kept outside projects. Indexing is
// read-only; the app's own downloads and imports are added to the root (inbox),
// only an approved inbox sort (수신함 정리) moves PDFs, and only a permanent
// deletion from the trash that was confirmed with "delete the PDFs" deletes them.
// By default that deletion hides the PDFs from the app and leaves them on disk.
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
/** The inbox is the shelf root: PDFs nobody has sorted yet. */
export const isInboxFolder = (relPath: string) => relPath === "";
/** `_uncategorized` and below: sorted, but no folder fitted. Shown apart from the inbox, re-sorted only on request. */
export const isUncategorizedFolder = (relPath: string) =>
  relPath === SHELF_UNCATEGORIZED || relPath.startsWith(SHELF_UNCATEGORIZED + "/");

export interface ShelfSortLeaf {
  /** Folder path relative to the shelf root, e.g. `01 Psychiatric Disorders/Mood Disorders - Clinical`. */
  path: string;
  domain: string;
  name: string;
  def: string;
}
/** A leaf the user names while filing: created in an existing domain, with an optional one-line definition. */
export interface ShelfNewLeaf {
  /** An existing domain; "" for the shelf's top level when the shelf has no taxonomy.json. */
  domain: string;
  name: string;
  def: string;
}
/** Destinations for filing by hand: every domain (empty ones too) with its leaves. */
export interface ShelfLeafList {
  taxonomy: "file" | "folders";
  domains: { name: string; leaves: (ShelfSortLeaf & { missing: boolean })[] }[];
}
export const leafPath = (leaf: Pick<ShelfNewLeaf, "domain" | "name">) => (leaf.domain ? `${leaf.domain}/${leaf.name}` : leaf.name);
/** How macOS and SMB shares compare folder names: Unicode-normalised and case-insensitive. */
export const folderKey = (name: string) => name.normalize("NFC").toLowerCase();
/**
 * Why a new leaf name is refused, or null: one path segment that is not a hidden (`.`)
 * or system (`_`) folder, has no character a NAS share refuses, and is not already a
 * folder of the domain (`siblings`), compared as the file system compares names.
 */
export function leafNameProblem(name: string, siblings: string[]): string | null {
  if (!name.trim()) return "폴더 이름을 입력하세요.";
  if (name !== name.trim()) return "이름 앞뒤의 공백을 지우세요.";
  if (/[/\\]/.test(name)) return "이름에 / 나 \\ 를 쓸 수 없습니다.";
  if (name.startsWith(".") || name.startsWith("_")) return "이름은 . 이나 _ 로 시작할 수 없습니다. 숨김 폴더나 시스템 폴더가 됩니다.";
  // eslint-disable-next-line no-control-regex
  if (/[:*?"<>|\u0000-\u001f\u007f]/.test(name) || name.endsWith(".")) return "이름에 : * ? \" < > | 나 제어 문자를 쓸 수 없고, 이름이 . 으로 끝날 수 없습니다.";
  if (name.length > 120) return "이름은 120자까지 쓸 수 있습니다.";
  if (siblings.some((s) => folderKey(s) === folderKey(name))) return "이 도메인에 같은 이름의 폴더가 이미 있습니다.";
  return null;
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
  /** Every file the proposal looked at, including those already moved. */
  covered?: string[];
}
/** The saved proposal plus the inbox as it is now. */
export interface ShelfSortView extends ShelfSortState {
  /** Inbox PDFs now (the shelf root). */
  inbox: number;
  /** PDFs in `_uncategorized` now; a proposal includes them only when asked. */
  uncategorized: number;
  /** Inbox PDFs that arrived after the proposal was made. */
  fresh: number;
  /** The proposal saw every inbox PDF and still has something to move, so reopening resumes it. */
  current: boolean;
}
export interface ShelfSortResult {
  moved: number;
  uncategorized: number;
  duplicated: number;
  skipped: { relPath: string; reason: string }[];
  /** The moves went to move_log.jsonl and logs/, and index.json was rebuilt. */
  ledger: boolean;
  /** Leaves this call added (their paths), before any file moved. */
  created?: string[];
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
/** `hidden`: still on disk, but removed from the app by a permanent deletion; the row has no work and is never listed. */
export type ShelfStatus = "ok" | "review" | "provisional" | "auxiliary" | "failed" | "missing" | "hidden";
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
  /** Set while the file is hidden: the work and status it had. */
  hidden?: { workId: string; status: ShelfStatus; at: string };
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
  /** `embed`: done/total count papers being embedded, not files being indexed. */
  phase?: "embed";
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
  /** The `_uncategorized` folder, listed apart from the tree; null while it holds no papers. */
  uncategorized: { id: string; count: number } | null;
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
/**
 * Changing the shelf folder: `remount` is the same tree at another path, `parent`
 * a folder above the shelf, `subfolder` a folder inside it, `new` another folder.
 */
export type ShelfMoveMode = "first" | "same" | "remount" | "parent" | "subfolder" | "new";
export interface ShelfMovePreview {
  from: string | null;
  to: string;
  mode: ShelfMoveMode;
  /** Indexed files that stay with their metadata and embeddings. */
  keep: number;
  /** Indexed files that leave the index; the files themselves are untouched. */
  drop: number;
  /** Project papers whose PDF link to a dropped file becomes a plain link to its old location. */
  links: number;
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
  /** The query was a DOI, PMID or OpenAlex ID and was looked up directly. */
  identifier?: boolean;
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
/** Cut `title` at a word, ending in " ...", so `${head}${title}.pdf` fits the shelf's limit. */
export function fitShelfTitle(head: string, title: string): string {
  if (bytes(head + title + ".pdf") <= MAX_FILENAME_BYTES) return title;
  const room = MAX_FILENAME_BYTES - bytes(head + " ....pdf");
  let cut = "";
  for (const char of title) {
    if (bytes(cut + char) > room) break;
    cut += char;
  }
  return `${cut.replace(/\s+\S*$/, "").trim() || cut.trim()} ...`;
}
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
  return `${head}${fitShelfTitle(head, clean(work.title).replace(/[.\s]+$/, "") || "Untitled")}.pdf`;
}

/** Accent- and case-insensitive surname token for first-author checks. */
export function surnameKey(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ").trim();
}
/** Surname particles a provider may drop or fold into the given name ("de Koning" ↔ "Marieke Koning"). */
const PARTICLES = new Set(["d", "da", "das", "de", "del", "della", "der", "den", "di", "do", "dos", "du", "la", "le", "st", "te", "ten", "ter", "van", "von", "zu"]);
export function authorMatches(filenameAuthor: string | undefined, providerAuthor: string | undefined): boolean {
  if (!filenameAuthor || !providerAuthor) return false;
  const parts = surnameKey(filenameAuthor).split(/\s+/);
  // Skip leading particles, but keep a surname such as "Le" that stands alone.
  const wanted = parts.find((p, i) => !PARTICLES.has(p) || i === parts.length - 1);
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
