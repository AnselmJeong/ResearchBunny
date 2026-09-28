export type ReadState = "unread" | "planned" | "reading" | "read";
export type Screening = "pending" | "included" | "excluded" | "trash";
export interface Work {
  id: string;
  openalex: string | null;
  doi: string | null;
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
  scope: string;
}
export interface WorkView extends Work {
  state: LibraryState;
  evidence?: Evidence;
  attachmentCount: number;
  collectionIds: string[];
  archiveTopicId?: string;
}
export interface Project {
  id: string;
  name: string;
  question: string;
  createdAt: string;
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
};
export interface Task {
  kind: "lookup" | "batch" | "search" | "cites";
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
export interface Run {
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
    index: number;
  };
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
}
export interface Settings {
  openalexConfigured: boolean;
  openaiConfigured: boolean;
  secureStorage: boolean | null;
  credentialMigrationRequired?: boolean;
  aiProvider: "codex" | "openai";
  codexModel: string;
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
  ui: Record<string, unknown>;
}
export interface ListResult {
  works: WorkView[];
  context?: WorkView[];
  total: number;
  hidden: number;
  deferred: number;
  ids: string[];
  edges: { source: string; target: string }[];
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
export interface AppEvent {
  type: "changed" | "progress" | "service-error";
  runId?: string;
  message?: string;
}
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
