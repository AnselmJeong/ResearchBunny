import { z } from "zod";
import type { CodexStatus, CodexModel } from "./codex";
import type { ChatSession, ChatThreadSummary } from "./chat";
import type {
  Snapshot,
  ListResult,
  WorkView,
  Run,
  ImportPreview,
  ImportResult,
  Attachment,
  Settings,
  Project,
  PdfDownloadPreview,
  MissingPdfs,
  PdfExportPreview,
  PdfExportResult,
  Collection,
  ClassificationJob,
  SeedProfile,
  AppEvent,
  Result,
  Work,
  LibraryState,
} from "./types";
const id = z.string().min(1).max(160);
const chatContext = z.discriminatedUnion("kind", [z.object({ kind: z.literal("abstract") }).strict(), z.object({ kind: z.literal("pdf-fulltext"), attachmentId: id }).strict()]);
const chatTarget = { projectId: id, workId: id, context: chatContext.optional(), threadId: id.optional() };
const pdfTarget = { projectId: id, workId: id, attachmentId: id };
const ids = z.array(id).max(10000);
const text = z.string().max(20000);
const downloadTarget = z.object({
  projectId: id,
  scope: z.enum(["archive", "selected", "topic", "unclassified", "collection"]),
  ids: ids.default([]),
  scopeId: id.optional(),
  includeBooks: z.boolean().default(false),
  useBrowser: z.boolean().default(false),
  downloadDirectory: z.string().min(1).max(4096).optional(),
});
const exportSelection = z.object({
  projectId: id,
  scope: z.enum(["selected", "project", "all", "collection"]),
  ids: ids.default([]),
  collectionId: id.optional(),
});
export const filtersSchema = z.object({
  reading: z.enum(["unread", "planned", "reading", "read"]).optional(),
  strictness: z.enum(["strict", "balanced", "broad"]),
  relevance: z.boolean(),
  minCitations: z.number().min(0).max(1e9),
  yearFrom: z.number().int().min(1000).max(2200).nullable(),
  yearTo: z.number().int().min(1000).max(2200).nullable(),
  unknownYear: z.boolean(),
  types: z.array(z.string().max(80)).max(30),
  include: z.string().max(1000),
  exclude: z.string().max(1000),
  minShared: z.number().int().min(1).max(10000),
  hasAbstract: z.boolean(),
  hasPdf: z.boolean(),
  openAccess: z.boolean(),
  hideSaved: z.boolean(),
  hideExcluded: z.boolean(),
  hideRetracted: z.boolean(),
});
const metadata = z
  .object({
    title: z.string().trim().min(1).max(5000).optional(),
    authors: z.array(z.string().max(500)).max(1000).optional(),
    year: z.number().int().min(1000).max(2200).nullable().optional(),
    doi: z.string().max(1000).nullable().optional(),
    venue: z.string().max(2000).optional(),
    type: z.string().max(80).optional(),
    abstract: text.nullable().optional(),
    volume: z.string().max(80).optional(),
    issue: z.string().max(80).optional(),
    pages: z.string().max(80).optional(),
    publisher: z.string().max(500).optional(),
  })
  .strict();
const state = z
  .object({
    screening: z.enum(["pending", "included", "excluded", "trash"]).optional(),
    reading: z.enum(["unread", "planned", "reading", "read"]).optional(),
    starred: z.boolean().optional(),
    tags: z.array(z.string().max(100)).max(100).optional(),
    note: text.optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict();
export const schemas = {
  snapshot: z.object({ projectId: id.optional() }),
  classifyArchive: z.object({ projectId: id }),
  cancelClassification: z.object({ projectId: id }),
  createProject: z.object({
    name: z.string().trim().min(1).max(160),
    question: text.default(""),
  }),
  updateProject: z.object({
    projectId: id,
    name: z.string().trim().min(1).max(160),
    question: text,
  }),
  createCollection: z.object({
    projectId: id,
    name: z.string().trim().min(1).max(160),
    parentId: id.nullable().default(null),
  }),
  collectionMembers: z.object({
    projectId: id,
    collectionId: id,
    ids,
    remove: z.boolean().default(false),
  }),
  list: z.object({
    projectId: id,
    scope: z.enum([
      "archive",
      "pending",
      "starred",
      "reading",
      "trash",
      "excluded",
      "run",
      "collection",
      "topic",
      "unclassified",
    ]),
    scopeId: id.optional(),
    query: z.string().max(1000).default(""),
    filters: filtersSchema,
    showHidden: z.boolean().default(false),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
    sort: z
      .enum(["rank", "year", "citations", "title", "updated"])
      .default("rank"),
  }),
  inspect: z.object({ projectId: id, workId: id, runId: id.optional() }),
  mutateWorks: z.object({ projectId: id, ids, patch: state }),
  restoreWorks: z.object({ projectId: id, ids }),
  clearPending: z.object({ projectId: id }),
  deleteTrashedWorks: z.object({
    projectId: id,
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("selected"), ids: ids.min(1) }),
      z.object({ kind: z.literal("all") }),
    ]),
  }),
  editWork: z.object({ workId: id, patch: metadata }),
  manualWork: z.object({ projectId: id, metadata }),
  setSeeds: z.object({
    projectId: id,
    ids: ids.max(100),
    question: text,
    groups: z.record(z.string().max(100), ids).default({}),
  }),
  startRun: z.object({
    projectId: id,
    mode: z.enum([
      "search",
      "related",
      "references",
      "citedBy",
      "commonReferences",
      "commonCiting",
      "ai",
    ]),
    query: z.string().trim().max(2000),
    ids: ids,
    filters: filtersSchema,
    sort: z.enum(["relevance", "citations", "year"]).default("relevance"),
    parentId: id.optional(),
    semantic: z.boolean().default(false),
  }),
  controlRun: z.object({
    runId: id,
    action: z.enum(["cancel", "resume", "more", "skip"]),
    useBrowser: z.boolean().optional(),
    downloadDirectory: z.string().min(1).max(4096).optional(),
  }),
  previewBib: z.object({ text: z.string().max(20_000_000) }),
  importBib: z.object({
    projectId: id,
    token: id,
    collectionId: id.optional(),
  }),
  chooseBib: z.object({}),
  chooseDownloadDirectory: z.object({}),
  choosePdfMatch: z.object({ projectId: id }),
  choosePdf: z.object({
    projectId: id,
    folder: z.boolean().default(false),
    mode: z.enum(["managed", "linked", "metadata"]).default("managed"),
    collectionId: id.optional(),
    mapFolders: z.boolean().default(false),
    workId: id.optional(),
  }),
  attachments: z.object({ workId: id }),
  pdfInfo: z.object(pdfTarget).strict(),
  pdfReadChunk: z.object({ ...pdfTarget, offset: z.number().int().min(0), length: z.number().int().min(1).max(512 * 1024) }).strict(),
  pdfDownloadPreview: downloadTarget,
  missingPdfs: downloadTarget,
  downloadPdfs: downloadTarget,
  importItems: z.object({ runId: id }),
  attachmentAction: z.object({
    attachmentId: id,
    action: z.enum(["open", "reveal", "relink"]),
  }),
  exportBib: z.object({
    projectId: id,
    scope: z.enum(["selected", "project", "all", "collection"]),
    ids: ids.default([]),
    collectionId: id.optional(),
    includeNotes: z.boolean().default(false),
    includeFiles: z.boolean().default(false),
  }),
  exportPreview: exportSelection,
  pdfExportPreview: exportSelection,
  exportPdfs: z.object({
    targets: z.array(z.object({ projectId: id, ids: ids.min(1) })).min(1).max(1000),
  }),
  backup: z.object({
    includeAttachments: z.boolean(),
    includeLinked: z.boolean(),
  }),
  restoreBackup: z.object({}),
  codexStatus: z.object({}),
  codexModels: z.object({}),
  codexLogin: z.object({}),
  codexCancelLogin: z.object({}),
  codexLogout: z.object({}),
  ollamaModels: z.object({}),
  chatSession: z.object(chatTarget),
  chatSend: z.object({ ...chatTarget, requestId: id, message: z.string().trim().min(1).max(8000), searchEnabled: z.boolean() }),
  chatCancel: z.object({ ...chatTarget, requestId: id }),
  chatClear: z.object(chatTarget),
  chatThreads: z.object(chatTarget),
  chatOpenSource: z.object({ ...chatTarget, messageId: id, index: z.number().int().min(0).max(20) }),
  saveSettings: z.object({
    aiProvider: z.enum(["ollama", "codex", "openai"]).optional(),
    ollamaModel: z.string().trim().min(1).max(120).optional(),
    codexModel: z.string().trim().max(120).default(""),
    openalexKey: z.string().max(1000).optional(),
    openaiKey: z.string().max(1000).optional(),
    ollamaKey: z.string().max(1000).optional(),
    pubmedKey: z.string().max(1000).optional(),
    tinyfishKey: z.string().max(1000).optional(),
    model: z.string().trim().min(1).max(120),
    aiEnabled: z.boolean(),
    theme: z.enum(["system", "light", "dark"]),
    aiMaxInputTokens: z.number().int().min(1000).max(100000),
    aiMaxOutputTokens: z.number().int().min(500).max(16000),
    aiBudgetUsd: z.number().min(0.01).max(100),
    inputPricePerMillion: z.number().min(0).max(1000),
    outputPricePerMillion: z.number().min(0).max(1000),
  }),
  testConnection: z.object({ provider: z.enum(["openalex", "openai", "ollama", "pubmed", "tinyfish"]) }),
  openExternal: z.object({
    workId: id.optional(),
    kind: z.enum([
      "doi",
      "source",
      "oa",
      "openalex-settings",
      "openai-settings",
      "ollama-settings",
      "pubmed-settings",
      "tinyfish-settings",
      "data-folder",
    ]),
  }),
  saveUi: z.object({
    projectId: id,
    value: z
      .record(z.string(), z.unknown())
      .refine((v) => JSON.stringify(v).length < 1_000_000),
  }),
  undo: z.object({ projectId: id }),
  duplicates: z.object({ workId: id }),
  merge: z.object({ keepId: id, removeId: id }),
  undoMerge: z.object({}),
};
export type Command = keyof typeof schemas;
export type Input<C extends Command> = z.input<(typeof schemas)[C]>;
export interface Outputs {
  importItems: {
    name: string;
    status: string;
    message: string;
    workId: string | null;
  }[];
  exportPreview: { ids: string[]; count: number };
  pdfExportPreview: PdfExportPreview;
  exportPdfs: PdfExportResult | null;
  snapshot: Snapshot;
  classifyArchive: ClassificationJob;
  cancelClassification: void;
  createProject: Project;
  updateProject: void;
  createCollection: Collection;
  collectionMembers: void;
  list: ListResult;
  inspect: WorkView;
  mutateWorks: void;
  restoreWorks: void;
  clearPending: { ids: string[] };
  deleteTrashedWorks: { ids: string[] };
  editWork: Work;
  manualWork: Work;
  setSeeds: SeedProfile;
  startRun: Run;
  controlRun: void;
  previewBib: ImportPreview;
  importBib: ImportResult;
  chooseBib: ImportPreview | null;
  chooseDownloadDirectory: string | null;
  choosePdfMatch: Run | null;
  choosePdf: Run | null;
  attachments: Attachment[];
  pdfInfo: { attachmentId: string; name: string; size: number; hash: string };
  pdfReadChunk: { base64: string; bytesRead: number };
  pdfDownloadPreview: PdfDownloadPreview;
  missingPdfs: MissingPdfs;
  downloadPdfs: Run;
  attachmentAction: void;
  exportBib: {
    path: string;
    count: number;
    mappings: { from: string; to: string }[];
  } | null;
  backup: { path: string; missing: string[] } | null;
  restoreBackup: { path: string; missing: string[] } | null;
  codexStatus: CodexStatus;
  codexModels: CodexModel[];
  codexLogin: void;
  codexCancelLogin: void;
  codexLogout: void;
  ollamaModels: string[];
  chatSession: ChatSession;
  chatThreads: ChatThreadSummary[];
  chatSend: ChatSession;
  chatCancel: void;
  chatClear: ChatSession;
  chatOpenSource: void;
  saveSettings: Settings;
  testConnection: { message: string };
  openExternal: void;
  saveUi: void;
  undo: boolean;
  duplicates: WorkView[];
  merge: void;
  undoMerge: boolean;
}
export type API = {
  [C in Command]: (input: Input<C>) => Promise<Outputs[C]>;
} & {
  onEvent: (callback: (event: AppEvent) => void) => () => void;
};
export type PayloadPatch = Partial<LibraryState>;
export type WireResult<C extends Command> = Result<Outputs[C]>;
declare global {
  interface Window {
    bunny: API;
  }
}
