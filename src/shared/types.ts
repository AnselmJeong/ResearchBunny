export type ReadState = "unread" | "planned" | "reading" | "read";
export type Screening = "pending" | "included" | "excluded" | "trash";
export interface Work {
  id: string;
  openalex: string | null;
  doi: string | null;
  pmid: string | null;
  title: string;
  authors: string[];
  year: number | null;
  type: string;
  venue: string;
  abstract: string | null;
  citations: number | null;
  topics: { id: string; name: string }[];
  references: string[] | null;
  related: string[];
  url: string | null;
  oaUrl: string | null;
  retracted: boolean;
  volume: string;
  issue: string;
  pages: string;
  publisher: string;
  citekey: string;
  source: string;
  fetchedAt: string;
  raw: Record<string, unknown>;
  bibFields?: Record<string, string>;
  bibType?: string;
  originalBib?: string;
  edits: Partial<
    Record<
      | "title"
      | "authors"
      | "year"
      | "venue"
      | "doi"
      | "type"
      | "volume"
      | "issue"
      | "pages"
      | "publisher"
      | "abstract",
      unknown
    >
  >;
}
export interface LibraryState {
  screening: Screening;
  pendingDismissed?: boolean;
  previousScreening?: Screening;
  reading: ReadState;
  starred: boolean;
  tags: string[];
  note: string;
  reason: string;
  updatedAt: string;
}
export interface Evidence {
  origins: string[];
  seedIds: string[];
  sharedIds: string[];
  coCitingIds?: string[];
  denominator: number;
  relation: string;
  score: number | null;
  reasons: string[];
  hidden: string[];
  deferred: boolean;
  ai?: { role: string; reason: string; quote: string; limitation: string };
  linked?: { score: number; seedIds: string[]; isReview?: boolean };
  shelf?: { score: number | null; folder: string; fileId: string };
  scope: string;
}
export interface ShelfMembership {
  fileId: string;
  folderId: string;
  folder: string;
  path: string;
  status: string;
  stage: string;
  copies: number;
  /** "title": only a filename title/year rule matched an unresolved shelf file. */
  match: "identity" | "title";
}
export interface WorkView extends Work {
  state: LibraryState;
  evidence?: Evidence;
  attachmentCount: number;
  collectionIds: string[];
  archiveTopicId?: string;
  shelf?: ShelfMembership;
}
export interface Project {
  id: string;
  name: string;
  question: string;
  createdAt: string;
}
/** What a project holds, for managing projects and confirming a deletion. */
export interface ProjectStats {
  /** Papers in the archive. */
  archive: number;
  /** Every paper the project keeps a state for: archive, review, trash and excluded. */
  entries: number;
  collections: number;
  /** Explorations, imports and full-text jobs. */
  runs: number;
  chats: number;
}
export interface Collection {
  id: string;
  projectId: string;
  name: string;
  parentId: string | null;
  count: number;
}
export interface ArchiveTopic {
  id: string;
  name: string;
  description: string;
  count: number;
  color: string;
}
export interface ClassificationJob {
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  message: string;
  updatedAt: string;
}
export interface ArchiveClassification {
  topics: ArchiveTopic[];
  unclassified: number;
  job: ClassificationJob | null;
}
export interface SeedProfile {
  id: string;
  projectId: string;
  version: number;
  question: string;
  /** English OpenAlex keyword queries for the question, which is prose and often Korean. */
  queries?: string[];
  ids: string[];
  groups: Record<string, string[]>;
  createdAt: string;
}
export type DiscoveryMode =
  | "search"
  | "related"
  | "references"
  | "citedBy"
  | "commonReferences"
  | "commonCiting"
  | "ai";
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "paused_budget"
  | "failed"
  | "interrupted";
export interface Filters {
  reading?: ReadState;
  strictness: "strict" | "balanced" | "broad";
  relevance: boolean;
  minCitations: number;
  yearFrom: number | null;
  yearTo: number | null;
  unknownYear: boolean;
  types: string[];
  include: string;
  exclude: string;
  minShared: number;
  hasAbstract: boolean;
  hasPdf: boolean;
  openAccess: boolean;
  hideSaved: boolean;
  hideExcluded: boolean;
  hideRetracted: boolean;
  shelf?: "all" | "hide" | "only";
}
export const DEFAULT_FILTERS: Filters = {
  strictness: "balanced",
  relevance: false,
  minCitations: 0,
  yearFrom: null,
  yearTo: null,
  unknownYear: true,
  types: [],
  include: "",
  exclude: "",
  minShared: 2,
  hasAbstract: false,
  hasPdf: false,
  openAccess: false,
  hideSaved: false,
  hideExcluded: true,
  hideRetracted: true,
  shelf: "all",
};
export interface Task {
  kind: "lookup" | "batch" | "search" | "cites" | "linked" | "pmidBatch" | "shelf";
  size?: LinkedSize;
  ids?: string[];
  query?: string;
  seedId?: string;
  origin: string;
  cursor?: string;
  sort?: string;
  done?: boolean;
  pages?: number;
  total?: number;
  pendingPage?: {
    works: Work[];
    cursor: string | null;
    total: number | null;
    cached: boolean;
    fetchedAt: string;
  };
}
export type LinkedSize = 20 | 50 | 100 | 200;
export interface LinkedNeighbor {
  pmid: string;
  score: number;
  isReview: boolean;
  isRetracted: boolean;
  diseases: string[];
  genes: string[];
  chemicals: string[];
}
export interface Run {
  linked?: Record<string, Record<string, LinkedNeighbor>>;
  linkedFailures?: Record<string, string>;
  id: string;
  projectId: string;
  mode: DiscoveryMode;
  query: string;
  seedProfileId: string | null;
  inputIds: string[];
  filters: Filters;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  calls: number;
  maxCalls: number;
  maxCandidates: number;
  total: number | null;
  count: number;
  message: string;
  tasks: Task[];
  rankingVersion: string;
  phase?: string;
  ai?: Record<string, unknown>;
  retryAt?: string;
  parentId?: string;
  import?: {
    paths: string[];
    mode: "managed" | "linked" | "metadata";
    collectionId?: string;
    mapFolders?: boolean;
    workId?: string;
    matchExistingOnly?: boolean;
    index: number;
  };
  download?: {
    items: PdfDownloadItem[];
    includeBooks: boolean;
    useBrowser?: boolean;
    /** Sci-Hub mirrors are tried after every other route fails. */
    useSciHub?: boolean;
    /** False for unattended runs: the app's Chrome never shows its window or waits for a person. */
    interactive?: boolean;
    downloadDirectory?: string;
  };
}
export type PdfDownloadScope = "archive" | "selected" | "topic" | "unclassified" | "collection";
export interface PdfDownloadItem {
  workId: string;
  title: string;
  status: "pending" | "running" | "completed" | "existing" | "skipped" | "failed";
  message: string;
  sourceUrl?: string;
  retrievalMethod?: "chrome" | "http";
  downloadedPath?: string;
  errorCode?: string;
}
export interface PdfDownloadPreview {
  total: number;
  existing: number;
  books: number;
  eligible: number;
  /** Works that can be linked from the shelf without a download. */
  shelf?: number;
  downloadDirectory?: string;
}
export interface MissingPdfItem {
  workId: string;
  title: string;
  status: "untried" | "pending" | "running" | "failed" | "skipped" | "missing";
  message: string;
  shelf?: { fileId: string; name: string; folder: string }[];
}
export interface MissingPdfs extends PdfDownloadPreview {
  items: MissingPdfItem[];
  /** The remembered Sci-Hub fallback settings. */
  sciHub?: { enabled: boolean; mirrors: string[] };
  /** `ready` once the person has opened the app's Chrome to log in. */
  chrome?: { ready: boolean };
}
export interface Attachment {
  id: string;
  workId: string;
  name: string;
  path: string;
  hash: string;
  mode: "managed" | "linked";
  size: number;
  status: string;
  exists: boolean;
  sourceUrl?: string;
  retrievalMethod?: "chrome" | "http";
  fetchedAt?: string;
  version?: string;
  shelfFileId?: string;
}
export interface PdfExportTarget {
  projectId: string;
  ids: string[];
}
export interface PdfExportPreview {
  targets: PdfExportTarget[];
  workCount: number;
  pdfCount: number;
  withoutPdf: number;
  unavailable: number;
  folders: { path: string; pdfCount: number }[];
}
export interface PdfExportResult {
  path: string;
  reportPath: string;
  workCount: number;
  pdfCount: number;
  withoutPdf: number;
  unavailable: number;
}
export interface Settings {
  linkedDiscoveries: boolean;
  openalexConfigured: boolean;
  openaiConfigured: boolean;
  ollamaConfigured: boolean;
  pubmedConfigured: boolean;
  tinyfishConfigured: boolean;
  secureStorage: boolean | null;
  credentialMigrationRequired?: boolean;
  aiProvider: "ollama" | "codex" | "openai" | "claude";
  ollamaModel: string;
  codexModel: string;
  /** A Claude Code model alias or name; empty uses the account default. */
  claudeModel: string;
  model: string;
  aiEnabled: boolean;
  aiMaxInputTokens: number;
  aiMaxOutputTokens: number;
  aiBudgetUsd: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  theme: "system" | "light" | "dark";
  dataPath: string;
  version: string;
  usage: {
    provider: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }[];
}
export interface Snapshot {
  projects: Project[];
  collections: Collection[];
  classification: ArchiveClassification;
  seeds: SeedProfile | null;
  seedHistory: SeedProfile[];
  runs: Run[];
  counts: Record<string, number>;
  settings: Settings;
  shelf: import("./shelf").ShelfSummary;
  genealogies: import("./genealogy").GenealogySummary[];
  ui: Record<string, unknown>;
}
export interface ListResult {
  works: WorkView[];
  context?: WorkView[];
  /** Run results found in the shelf, pinned above external results. */
  shelf?: WorkView[];
  /** Set when a shelf list was ranked by a search; `semantic` is false when only words matched (Ollama off). */
  search?: { semantic: boolean; identifier: boolean };
  total: number;
  hidden: number;
  deferred: number;
  ids: string[];
  edges: { source: string; target: string }[];
  /** Graph requests: papers in scope linked to another paper; the rest are not drawn. */
  graph?: { connected: number };
  /** Shelf graphs: each drawn work's subfolder path directly below the listed folder. */
  subfolders?: Record<string, string>;
}
/** The inspector's own lists for one paper: what it cites, what cites it and what is like it. */
export type LinkMode = "related" | "references" | "citedBy";
export interface LinkedWork {
  id: string;
  title: string;
  /** The first three authors; `authorCount` says how many there are. */
  authors: string[];
  authorCount: number;
  year: number | null;
  venue: string;
  citations: number | null;
  doi: string | null;
  /** "pending" also stands for a paper this project has never seen. */
  screening: Screening;
  /** The shelf folder holding the paper's PDF. */
  shelf: string | null;
  /** Similarity, for shelf and PubMed neighbours. */
  score: number | null;
}
export interface LinkGroup {
  key: "references" | "local" | "citing" | "shelf" | "pubmed" | "openalex";
  label: string;
  items: LinkedWork[];
  /** How many the source holds; more than `items` when it pages or some were not found. */
  total: number | null;
  /** The next OpenAlex page. */
  cursor: string | null;
  note?: string;
}
export interface WorkLinks {
  groups: LinkGroup[];
  notices: string[];
}
export interface ImportPreview {
  token: string;
  items: {
    title: string;
    citekey: string;
    status: "new" | "existing" | "conflict" | "error";
    message: string;
  }[];
}
export interface ImportResult {
  added: number;
  linked: number;
  pending: number;
  errors: { name: string; message: string }[];
  ids: string[];
}
export type AppEvent = {
  type: "changed" | "progress" | "service-error" | "shelf";
  runId?: string;
  message?: string;
} | { type: "chat"; session: import("./chat").ChatSession }
  /** `finished` comes once, when a run has rendered the report. */
  | { type: "genealogy"; id: string; finished?: { title: string; body: string } }
  /** The app's Chrome needs the person (robot check, login); `pid` lets main bring that Chrome forward. */
  | { type: "attention"; message: string; pid?: number }
  | { type: "passages"; job: import("./passages").PassageJob }
  | { type: "answer"; id: string; step: import("./passages").AnswerStep; message: string };
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const defaultState = (): LibraryState => ({
  screening: "pending",
  pendingDismissed: false,
  reading: "unread",
  starred: false,
  tags: [],
  note: "",
  reason: "",
  updatedAt: now(),
});
