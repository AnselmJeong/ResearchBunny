import type { Settings } from "./types";

/** Genealogy reports run long jobs on subscriptions or Ollama only; the paid OpenAI API is never used for them. */
export type GenealogyProvider = "codex" | "claude" | "ollama";
export interface ModelRoute {
  provider: GenealogyProvider;
  /** Empty uses the account's default model. */
  model: string;
}
/** light: types, section boundaries, candidate judgements. cards: one call per paper. write: ledger, outline, sections, review. */
export type GenealogyStage = "light" | "cards" | "write";
export type ModelRoutes = Record<GenealogyStage, ModelRoute>;

/** Every stage starts on the connection chosen in Settings, falling back to Codex when that is the paid API. */
export function defaultRoutes(settings: Pick<Settings, "aiProvider" | "codexModel" | "claudeModel" | "ollamaModel">): ModelRoutes {
  const route: ModelRoute =
    settings.aiProvider === "claude"
      ? { provider: "claude", model: settings.claudeModel }
      : settings.aiProvider === "ollama"
        ? { provider: "ollama", model: settings.ollamaModel }
        : { provider: "codex", model: settings.aiProvider === "codex" ? settings.codexModel : "" };
  return { light: { ...route }, cards: { ...route }, write: { ...route } };
}

export const PROVIDER_NAMES: Record<GenealogyProvider, string> = {
  codex: "Codex 구독",
  claude: "Claude 구독",
  ollama: "Ollama Cloud",
};

/** R review, concept, history or commentary · M systematic review or meta-analysis · O original research · P peripheral. */
export type PaperType = "R" | "M" | "O" | "P";
export const PAPER_TYPES: Record<PaperType, string> = {
  R: "종설·논평",
  M: "체계적 고찰·메타분석",
  O: "원저",
  P: "주변 문헌",
};
/** What a paper's card was read from. */
export type TextBasis = "jats" | "pdf" | "abstract" | "none";
export const TEXT_BASIS: Record<TextBasis, string> = {
  jats: "PMC 전문",
  pdf: "PDF 본문",
  abstract: "초록만",
  none: "본문 없음",
};
export type PaperOrigin = "collection" | "archive" | "shelf" | "openalex";
export const ORIGINS: Record<PaperOrigin, string> = {
  collection: "컬렉션",
  archive: "아카이브에서 추가",
  shelf: "서고에서 추가",
  openalex: "OpenAlex에서 추가",
};

export type ExpansionMode = "off" | "suggest" | "auto";
export interface GenealogySettings {
  question: string;
  /** Who the report is written for, e.g. "이 분야를 처음 시작하는 연구자". */
  reader: string;
  expansion: ExpansionMode;
  /** Most papers one expansion round adds. */
  perRound: number;
  rounds: number;
  /** Most growth over the starting collection, as a fraction (0.5 = 50%). */
  growth: number;
  routes: ModelRoutes;
  /** Stop after the outline so it can be read and edited before writing. */
  pauseAtOutline: boolean;
  /** Fetch missing PDFs with the archive's full-text job before reading. */
  fetchPdfs: boolean;
  /** Let that job use Chrome, as in the archive's PDF dialog. */
  useBrowser: boolean;
  /** AI calls one job may make. */
  maxCalls: number;
  /** Papers carded at the same time. */
  concurrency: number;
  /** Absolute path of a CSL style; empty uses the bundled numeric (Vancouver-type) style. */
  csl: string;
}
export const DEFAULT_READER = "이 분야를 처음 시작하는 연구자";
export function defaultGenealogySettings(settings: Pick<Settings, "aiProvider" | "codexModel" | "claudeModel" | "ollamaModel">, question = ""): GenealogySettings {
  return {
    question,
    reader: DEFAULT_READER,
    expansion: "auto",
    perRound: 15,
    rounds: 3,
    growth: 0.5,
    routes: defaultRoutes(settings),
    pauseAtOutline: true,
    fetchPdfs: true,
    useBrowser: false,
    maxCalls: 600,
    concurrency: 3,
    csl: "",
  };
}

/** Steps run in this order; "continue" runs from the first unfinished one. */
export const STEPS = ["prepare", "cards", "gaps", "outline", "write", "check", "render"] as const;
export type GenealogyStep = (typeof STEPS)[number];
export const STEP_NAMES: Record<GenealogyStep, string> = {
  prepare: "자료 준비",
  cards: "문헌 카드",
  gaps: "공백 점검",
  outline: "가지 장부·목차",
  write: "집필",
  check: "검증",
  render: "렌더",
};
export type JobStatus = "running" | "paused" | "failed" | "completed" | "cancelled" | "interrupted";
export interface GenealogyJob {
  step: GenealogyStep;
  status: JobStatus;
  message: string;
  done: number;
  total: number;
  calls: number;
  /** Keep going into later steps until a pause point. */
  auto: boolean;
  startedAt: string;
  updatedAt: string;
  /** When a spent subscription resets, if the provider said. */
  retryAt?: string;
}

export interface Genealogy {
  id: string;
  projectId: string;
  collectionId: string;
  title: string;
  workspace: string;
  settings: GenealogySettings;
  /** Steps that finished, with when. */
  completed: Partial<Record<GenealogyStep, string>>;
  job: GenealogyJob | null;
  /** Expansion rounds run so far. */
  rounds: number;
  /** The paper count when the report was created; growth is measured against it. */
  startSize: number;
  outlineApproved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GenealogyPaper {
  workId: string;
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  doi: string | null;
  origin: PaperOrigin;
  round: number;
  reason: string;
  type: PaperType | null;
  typeSource: "metadata" | "ai" | "user" | null;
  typeReason: string;
  basis: TextBasis;
  /** What was found in the text: sections, guesses, problems. */
  textNote: string;
  /** Characters the card reads. */
  textSize: number;
  cardStatus: "none" | "done" | "failed" | "stale";
  cardError: string;
  /** False once the paper left the collection; its card is kept in case it returns. */
  included: boolean;
  hasPdf: boolean;
  /** An open-access PMC article whose structured full text Europe PMC serves. */
  pmcid: string | null;
  pmcChecked: boolean;
  addedAt: string;
}

/** One paper's extraction, read for the outline and writing. Numbers stay verbatim. */
export interface GenealogyCard {
  key: string;
  type: PaperType;
  /** Who it answers and who takes it up. */
  position: string;
  problem: string;
  claims: string[];
  evidence: { text: string; quote: string }[];
  critique: string;
  unresolved: string[];
  interests: string;
  significance: string;
  foundations: { mention: string; role: "origin" | "support" | "refute" | "method" | "review"; claim: string }[];
  statusSignals: string[];
  cautions: string[];
}

export type CandidateSignal = "cocited" | "mention" | "forward" | "request";
export interface GapCandidate {
  id: string;
  workId: string | null;
  openalex: string | null;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  /** How many genealogy papers cite it, and which. */
  cocited: string[];
  /** Mentions in cards: the citing paper's key and the text as written. */
  mentions: { key: string; text: string; role: string }[];
  /** Genealogy papers it cites (forward signal). */
  cites: string[];
  /** Sections that asked for evidence it may supply. */
  requests: { section: string; need: string }[];
  score: number;
  relevance: number | null;
  role: string;
  reason: string;
  decision: "pending" | "accepted" | "rejected" | "added";
  /** Where an added paper was found. */
  foundIn: PaperOrigin | null;
  round: number;
  createdAt: string;
}

export type BranchStatus = "alive" | "blocked" | "merged" | "dormant" | "contested";
export const BRANCH_STATUS: Record<BranchStatus, string> = {
  alive: "살아남음",
  blocked: "막힘",
  merged: "합류",
  dormant: "휴면",
  contested: "논쟁 중",
};
export interface Branch {
  id: string;
  name: string;
  origin: string[];
  claim: string;
  turningPoints: { key: string; note: string }[];
  status: BranchStatus;
  /** Why the status: cards, refutations, citation trend. */
  evidence: string;
  /** For blocked branches: refuted, methodological wall, superseded, no tools. */
  reason: string;
  lastActive: number | null;
}

export interface MissingSource {
  need: string;
  hint: string;
  kind: "primary" | "recent" | "counter";
}
export interface OutlineSection {
  /** "2" for a chapter, "2.3" for a section. */
  id: string;
  chapter: number;
  title: string;
  thesis: string;
  questions: string[];
  evidence: string;
  keys: string[];
  branches: string[];
  status: "planned" | "written" | "stale" | "edited";
  summary: string;
  usedKeys: string[];
  missing: MissingSource[];
  problems: string[];
  rewrites: number;
  writtenAt: string | null;
}
export interface OutlineChapter {
  number: number;
  title: string;
  thesis: string;
  file: string;
  sections: OutlineSection[];
}
export interface Outline {
  title: string;
  subtitle: string;
  summary: string;
  chapters: OutlineChapter[];
}

export interface CheckItem {
  id: string;
  label: string;
  ok: boolean;
  details: string[];
}
export interface GenealogyOutputs {
  markdown: string | null;
  bib: string | null;
  epub: string | null;
  pdf: string | null;
  renderedAt: string | null;
  errors: string[];
}

export interface GenealogySummary {
  id: string;
  title: string;
  collectionId: string;
  papers: number;
  job: GenealogyJob | null;
  updatedAt: string;
}
export interface GenealogyView {
  genealogy: Genealogy;
  collectionName: string;
  papers: GenealogyPaper[];
  candidates: GapCandidate[];
  branches: Branch[];
  outline: Outline | null;
  checks: CheckItem[];
  outputs: GenealogyOutputs;
  /** Cards by work id. */
  cards: Record<string, GenealogyCard>;
  /** The connections the report can use, for the settings form. */
  tools: { pandoc: string | null; typst: string | null };
}
