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

// Answers ("답변"): a question answered from passages only. The service finds
// passages for the question, a connected AI writes statements that cite them by
// number with a quote, and every quote is checked against its passage.

export type AnswerStep = "plan" | "search" | "write" | "check";
/** Cited: a quote was found in a passage. Unverified: its quotes were not. Uncited: no source was given. */
export type AnswerStatementStatus = "cited" | "unverified" | "uncited";
export interface AnswerStatement {
  text: string;
  /** Starts a new paragraph. */
  paragraph: boolean;
  /** 1-based numbers into `refs`. */
  refs: number[];
  status: AnswerStatementStatus;
  /** Numbers in the text that none of its cited passages contains. */
  unsupported: string[];
}
export interface AnswerRef {
  /** The number shown in the answer. */
  n: number;
  hit: PassageHit;
  /** Checked quotes from this passage, to mark in its text. */
  quotes: string[];
}
export interface PassageAnswer {
  question: string;
  /** Search queries the passages were found with, the question first. */
  queries: string[];
  statements: AnswerStatement[];
  refs: AnswerRef[];
  /** Passages given to the AI and not cited. */
  unused: PassageHit[];
  /** The passages do not answer the question well; `missing` says what they lack. */
  insufficient: boolean;
  missing: string;
  /** Citations dropped because their quote was not in the passage. */
  dropped: number;
  semantic: boolean;
  coverage: PassageSearchResult["coverage"];
  provider: string;
  model: string;
  createdAt: string;
  elapsedMs: number;
}
