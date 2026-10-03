export interface ChatSource {
  title: string;
  url: string;
  content: string;
  source?: "pubmed" | "openalex-semantic" | "web";
  pmid?: string;
  doi?: string;
}

export type ChatContextRef = { kind: "abstract" } | { kind: "pdf-fulltext"; attachmentId: string };
export const ABSTRACT_CONTEXT: ChatContextRef = { kind: "abstract" };
export function chatScope(context: ChatContextRef = ABSTRACT_CONTEXT) {
  return context.kind === "abstract" ? "abstract" : `pdf:${context.attachmentId}`;
}

// Full-text evidence is resolved only by the backend from a registered attachment.
export type ArticleContext = {
  workId: string;
  title: string;
  text: string;
} & (
  | { kind: "abstract"; missing: boolean }
  | { kind: "pdf-fulltext"; attachmentId: string; referencesExcluded: boolean; attachmentHash: string; pageCount: number; notice: string }
);

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status: "complete" | "streaming" | "failed" | "cancelled";
  sources?: ChatSource[];
  notice?: string;
  provider?: string;
  contextKind?: ArticleContext["kind"];
  searchEnabled?: boolean;
  context?: ArticleContext;
}

export interface ChatThreadSummary {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatSession {
  threadId: string;
  context: ChatContextRef;
  createdAt: string;
  projectId: string;
  workId: string;
  messages: ChatMessage[];
  activeRequestId: string | null;
  phase: string;
  revision: number;
}

export interface ChatTurnInput {
  context?: ChatContextRef;
  threadId?: string;
  projectId: string;
  workId: string;
  requestId: string;
  message: string;
  searchEnabled: boolean;
}
