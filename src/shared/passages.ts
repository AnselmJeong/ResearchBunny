// Passages ("본문 구절"): the shelf PDFs' body text split into paragraph-sized
// chunks, indexed for keyword (FTS5) and meaning (local Ollama embeddings)
// search. The index is derived data in its own `passages.sqlite` beside the
// library: deleting it only means indexing again.

export interface PassageJob {
  state: "idle" | "running" | "paused" | "waiting" | "offline";
  message: string;
  /** PDFs split into passages / PDFs on the shelf that should be. */
  docs: { done: number; total: number };
  /** Passages embedded with the current model / passages stored. */
  passages: { done: number; total: number };
  /** Passages embedded per second over the last minutes, while embedding. */
  rate?: number;
  updatedAt: string;
}
export interface PassageStatus {
  job: PassageJob;
  /** PDFs without a text layer (scans) and PDFs that could not be read. */
  empty: number;
  failed: number;
  model: string | null;
}
export interface PassageHit {
  passageId: number;
  workId: string;
  fileId: string;
  attachmentId: string | null;
  title: string;
  authors: string[];
  year: number | null;
  folder: string;
  /** 1-based PDF page numbers. */
  page: number;
  pageEnd: number;
  section: string;
  text: string;
  score: number;
  lexicalRank: number | null;
  semanticRank: number | null;
}
export interface PassageSearchResult {
  hits: PassageHit[];
  /** Words to highlight in the passages. */
  terms: string[];
  semantic: boolean;
  /** How much of the shelf the search covered. */
  coverage: { docs: number; total: number; embedded: number; passages: number };
}
