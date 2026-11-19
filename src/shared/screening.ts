// AI relevance screening ("AI 심사"): each project keeps an intent, inclusion
// and exclusion criteria, and a purpose. A paper is judged on two axes: topic
// relevance (does it address the question; criteria belong here) and role fit
// (is it useful for what the papers are being gathered for). The AI only
// recommends; the person decides what enters the archive.

/** What the papers are gathered for. The topic stays the same; the papers wanted differ. */
export type ScreeningPurpose = "genealogy" | "original" | "custom";
export const PURPOSE_NAMES: Record<ScreeningPurpose, string> = {
  genealogy: "계보·종설",
  original: "원저 연구",
  custom: "직접 정의",
};

export interface Criterion {
  id: string;
  text: string;
}
/** A purpose question asks whether a paper can play one role for the purpose. */
export interface RoleQuestion {
  id: string;
  label: string;
  /** The question as the model reads it, in English. */
  question: string;
}

export const PURPOSE_QUESTIONS: Record<Exclude<ScreeningPurpose, "custom">, RoleQuestion[]> = {
  genealogy: [
    { id: "concepts", label: "기본 개념과 흐름 정리", question: "Does the paper lay out the field's basic concepts or trace how the field developed?" },
    { id: "origin", label: "가설·연구 계열의 출발점", question: "Is the paper the starting point of a hypothesis or a line of research that later work took up?" },
    { id: "debate", label: "논쟁 정리 또는 반박", question: "Does the paper set out both sides of a debate, or argue against one side with evidence?" },
    { id: "fate", label: "계열이 버려지거나 살아남은 이유", question: "Does the paper explain why a line of work was abandoned, refuted, superseded or survived?" },
  ],
  original: [
    { id: "primary", label: "일차 자료 보고", question: "Does the paper report its own primary data (an experiment, trial, cohort, case series or measurements)?" },
    { id: "comparable", label: "비교할 만한 대상·설계", question: "Are the paper's population and study design comparable to those a new original study on this question would use?" },
    { id: "method", label: "다시 쓸 방법·도구·패러다임", question: "Does the paper present a method, tool, scale or experimental paradigm that another study could reuse?" },
    { id: "numbers", label: "효과 크기·수치", question: "Does the paper report effect sizes or other quantitative results?" },
  ],
};

export interface ScreeningProfile {
  projectId: string;
  purpose: ScreeningPurpose;
  /** For a custom purpose: its name and role questions. */
  custom: { label: string; questions: RoleQuestion[] };
  /** Two or three sentences: what the project wants to know and what it does not want. */
  intent: string;
  include: Criterion[];
  exclude: Criterion[];
  /** Exclusion criteria proposed from recommendations the person turned down. */
  suggestions: { id: string; text: string; workId: string; createdAt: string }[];
  /** Goes up whenever the intent or a criterion changes; older judgments are then marked stale. */
  version: number;
  /** Which models judge: the decision model first then the generative model, or one of them alone. */
  mode: ScreeningMode;
  /** The Ollama Cloud decision model. */
  decisionModel: string;
  updatedAt: string;
}
export type ScreeningMode = "two-stage" | "decision" | "generative";
export const MODE_NAMES: Record<ScreeningMode, string> = {
  "two-stage": "결정 모델 + 생성 모델",
  decision: "결정 모델만",
  generative: "생성 모델만",
};
export const DECISION_MODELS = ["clef", "clef-flash", "nimble", "tev1"] as const;
export const DEFAULT_DECISION_MODEL = "clef";

export function defaultProfile(projectId: string, question = ""): ScreeningProfile {
  return {
    projectId,
    purpose: "genealogy",
    custom: { label: "", questions: [] },
    intent: question,
    include: [],
    exclude: [],
    suggestions: [],
    version: 1,
    mode: "two-stage",
    decisionModel: DEFAULT_DECISION_MODEL,
    updatedAt: new Date(0).toISOString(),
  };
}

export function roleQuestions(profile: Pick<ScreeningProfile, "purpose" | "custom">, purpose = profile.purpose): RoleQuestion[] {
  return purpose === "custom" ? profile.custom.questions : PURPOSE_QUESTIONS[purpose];
}
/** Role answers are stored per purpose; a custom purpose is keyed by its questions so editing them asks again. */
export function purposeKey(profile: Pick<ScreeningProfile, "purpose" | "custom">, purpose = profile.purpose): string {
  if (purpose !== "custom") return purpose;
  return `custom:${profile.custom.questions.map((q) => q.question.trim().toLowerCase()).join("|")}`;
}

// ---- the paper's character: judged once, whatever the project or purpose ----

/** R review, concept or commentary · M systematic review or meta-analysis · O original research. */
export type CharacterType = "R" | "M" | "O";
export const CHARACTER_TYPES: Record<CharacterType, string> = {
  R: "종설·논평",
  M: "체계적 고찰·메타분석",
  O: "원저",
};
export type Contribution = "concept" | "origin" | "debate" | "method" | "primary" | "rebuttal";
export const CONTRIBUTIONS: Record<Contribution, { label: string; question: string }> = {
  concept: { label: "개념 정리", question: "Does the paper define, organise or clarify the field's concepts?" },
  origin: { label: "출발점이 된 연구", question: "Does the paper introduce a new hypothesis, model or line of research for the first time?" },
  debate: { label: "논쟁 정리", question: "Does the paper review a controversy, weighing the evidence on more than one side?" },
  method: { label: "방법 제시", question: "Does the paper present a new or adapted method, instrument, scale, protocol or paradigm?" },
  primary: { label: "일차 자료", question: "Does the paper report its own primary data or measurements?" },
  rebuttal: { label: "반박", question: "Does the paper argue against or fail to replicate an earlier claim or finding?" },
};
export interface PaperCharacter {
  type: CharacterType | null;
  contributions: Contribution[];
  /** Where the type came from: bibliographic records, a model or the person. */
  source: "metadata" | "ai" | "user";
  reason: string;
  model?: string;
  judgedAt: string;
}

// ---- one paper's judgment in one project ----

export type Recommendation = "include" | "maybe" | "exclude";
export const RECOMMENDATION_NAMES: Record<Recommendation, string> = {
  include: "포함 추천",
  maybe: "보류",
  exclude: "제외 추천",
};
export type TopicVerdict = "relevant" | "uncertain" | "off";
export type Verdict = "yes" | "no" | "unclear";

export interface CriterionJudgment {
  /** The decision model's probability that the criterion holds (inclusion) or applies (exclusion). */
  p?: number;
  /** The generative model's reading. */
  verdict?: Verdict;
}
export interface RoleJudgment {
  /** Probability per role question, or the generative model's verdict mapped to 1 / 0.5 / 0. */
  answers: Record<string, number>;
  model: string;
  judgedAt: string;
}
export interface ScreenResult {
  topic: TopicVerdict;
  /** 0 (unrelated) to 4 (directly addresses the question), when a model scored it. */
  relevance: number | null;
  criteria: Record<string, CriterionJudgment>;
  /** Role answers per purpose key; changing the purpose asks only these again. */
  roles: Record<string, RoleJudgment>;
  /** A short Korean reason, from the generative model. */
  reason: string;
  /** Words copied from the title or abstract that back the reason. */
  quote: string;
  /** False when the quote is not in the title or abstract: the reason is then less trustworthy. */
  quoteChecked: boolean;
  /** "none": no abstract, so no model was asked. */
  basis: "abstract" | "title" | "none";
  stages: ("decision" | "generative")[];
  models: { decision?: string; generative?: string };
  promptVersion: string;
  criteriaVersion: number;
  /** A failure leaves the paper 보류, never excluded. */
  error?: string;
  screenedAt: string;
}

/** What a list row and the inspector show. */
export interface ScreenView {
  recommendation: Recommendation;
  topic: TopicVerdict;
  relevance: number | null;
  /** Criteria that decided the recommendation, as "제외 기준 2: 동물 연구". */
  hits: string[];
  /** Why a relevant paper waits: no role for the purpose. */
  roleNote: string;
  reason: string;
  quote: string;
  quoteChecked: boolean;
  basis: ScreenResult["basis"];
  stale: boolean;
  /** Role answers for the current purpose were never asked. */
  roleMissing: boolean;
  models: ScreenResult["models"];
  error?: string;
  screenedAt: string;
  criteria: { id: string; kind: "include" | "exclude"; label: string; text: string; p?: number; verdict?: Verdict }[];
  roles: { id: string; label: string; value: number }[];
}

export const PROMPT_VERSION = "screen-1";

/** Probability above which an exclusion criterion clearly applies, and below which an inclusion criterion clearly fails. */
export const CLEAR = 0.9;
/** An inclusion criterion is met above this; an exclusion criterion is clear of the paper below CLEAN. */
export const MET = 0.7;
export const CLEAN = 0.4;

const criterionLabel = (kind: "include" | "exclude", index: number, text: string) =>
  `${kind === "include" ? "포함" : "제외"} 기준 ${index + 1}: ${text.length > 40 ? text.slice(0, 39) + "…" : text}`;

/**
 * Topic relevance from the criterion judgments. Exclusion needs a clear
 * violation; anything short of that is uncertain, never excluded.
 */
export function topicOf(profile: Pick<ScreeningProfile, "include" | "exclude">, result: Pick<ScreenResult, "criteria" | "relevance">): { topic: TopicVerdict; hits: string[] } {
  const judged = (id: string) => result.criteria[id] || {};
  const applies = (id: string) => {
    const j = judged(id);
    return j.verdict ? j.verdict === "yes" : j.p !== undefined && j.p >= CLEAR;
  };
  const fails = (id: string) => {
    const j = judged(id);
    return j.verdict ? j.verdict === "no" : j.p !== undefined && j.p <= 1 - CLEAR;
  };
  const met = (id: string) => {
    const j = judged(id);
    return j.verdict ? j.verdict === "yes" : j.p !== undefined && j.p >= MET;
  };
  const clean = (id: string) => {
    const j = judged(id);
    return j.verdict ? j.verdict === "no" : j.p !== undefined && j.p < CLEAN;
  };
  const excluded = profile.exclude.flatMap((c, i) => (applies(c.id) ? [criterionLabel("exclude", i, c.text)] : []));
  const failed = profile.include.flatMap((c, i) => (fails(c.id) ? [criterionLabel("include", i, c.text)] : []));
  if (excluded.length || failed.length) return { topic: "off", hits: [...excluded, ...failed] };
  const relevance = result.relevance;
  const criteria = profile.include.length + profile.exclude.length;
  // With no criterion to go by, only an unrelated score is clear enough to exclude.
  if (!criteria && relevance !== null && relevance <= 0.5) return { topic: "off", hits: ["주제와 무관"] };
  const allMet = profile.include.every((c) => met(c.id));
  const allClean = profile.exclude.every((c) => clean(c.id));
  if (allMet && allClean && (relevance === null ? criteria > 0 : relevance >= 2)) return { topic: "relevant", hits: [] };
  const unsure = [
    ...profile.include.flatMap((c, i) => (met(c.id) ? [] : [criterionLabel("include", i, c.text)])),
    ...profile.exclude.flatMap((c, i) => (clean(c.id) ? [] : [criterionLabel("exclude", i, c.text)])),
  ];
  return { topic: "uncertain", hits: unsure.length ? unsure.map((h) => `${h} (불확실)`) : relevance !== null && relevance < 2 ? ["관련성 낮음"] : [] };
}

/** How well a paper serves the purpose: its best role, or null when the role questions were not asked. */
export function roleFit(result: Pick<ScreenResult, "roles">, key: string): number | null {
  const answers = result.roles[key]?.answers;
  if (!answers) return null;
  const values = Object.values(answers);
  return values.length ? Math.max(...values) : null;
}
export const ROLE_FIT = 0.4;

/** The recommendation for the purpose in force. A relevant paper with no role for the purpose waits instead of being excluded. */
export function recommend(profile: ScreeningProfile, result: ScreenResult): { recommendation: Recommendation; hits: string[]; roleNote: string; roleMissing: boolean } {
  if (result.error || result.basis === "none") return { recommendation: "maybe", hits: [], roleNote: "", roleMissing: false };
  const { topic, hits } = topicOf(profile, result);
  if (topic === "off") return { recommendation: "exclude", hits, roleNote: "", roleMissing: false };
  if (topic === "uncertain") return { recommendation: "maybe", hits, roleNote: "", roleMissing: false };
  const questions = roleQuestions(profile);
  if (!questions.length) return { recommendation: "include", hits, roleNote: "", roleMissing: false };
  const fit = roleFit(result, purposeKey(profile));
  if (fit === null) return { recommendation: "include", hits, roleNote: "", roleMissing: true };
  if (fit >= ROLE_FIT) return { recommendation: "include", hits, roleNote: "", roleMissing: false };
  const name = profile.purpose === "custom" ? profile.custom.label || PURPOSE_NAMES.custom : PURPOSE_NAMES[profile.purpose];
  return { recommendation: "maybe", hits, roleNote: `주제 관련 · ${name} 목적에 맞는 역할 없음`, roleMissing: false };
}

export function screenView(profile: ScreeningProfile, result: ScreenResult): ScreenView {
  const { recommendation, hits, roleNote, roleMissing } = recommend(profile, result);
  const key = purposeKey(profile);
  const answers = result.roles[key]?.answers || {};
  return {
    recommendation,
    topic: result.topic,
    relevance: result.relevance,
    hits,
    roleNote,
    reason: result.reason,
    quote: result.quote,
    quoteChecked: result.quoteChecked,
    basis: result.basis,
    stale: result.criteriaVersion !== profile.version,
    roleMissing,
    models: result.models,
    error: result.error,
    screenedAt: result.screenedAt,
    criteria: [
      ...profile.include.map((c, i) => ({ id: c.id, kind: "include" as const, label: `포함 ${i + 1}`, text: c.text, ...result.criteria[c.id] })),
      ...profile.exclude.map((c, i) => ({ id: c.id, kind: "exclude" as const, label: `제외 ${i + 1}`, text: c.text, ...result.criteria[c.id] })),
    ],
    roles: roleQuestions(profile).flatMap((q) => (q.id in answers ? [{ id: q.id, label: q.label, value: answers[q.id] }] : [])),
  };
}

// ---- jobs ----

export type ScreeningTarget =
  | { kind: "run"; runId: string }
  | { kind: "archive" }
  | { kind: "collection"; collectionId: string }
  | { kind: "ids"; ids: string[] };
export interface ScreeningJob {
  kind: "screen" | "evaluate";
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  message: string;
  done: number;
  total: number;
  /** What the finished job recommended. */
  counts?: Record<Recommendation, number>;
  target?: ScreeningTarget["kind"];
  updatedAt: string;
}
export interface ScreeningSnapshot {
  profile: ScreeningProfile;
  job: ScreeningJob | null;
  evaluation: EvaluationReport | null;
  /** Whether the decision model (an Ollama Cloud key) and the generative model (AI turned on in Settings) can be used. */
  ready: { decision: boolean; generative: boolean };
}

// ---- evaluation: the person's own decisions are the answer key ----

export interface EvaluationConfig {
  mode: ScreeningMode;
  label: string;
}
export interface EvaluationScore {
  mode: ScreeningMode;
  label: string;
  /** Archive papers (relevant) and trashed or removed papers (not relevant) judged. */
  relevant: number;
  irrelevant: number;
  /** Relevant papers recommended for exclusion: the share must stay at or below 5%. */
  missed: number;
  missRate: number;
  /** Irrelevant papers recommended for exclusion. */
  caught: number;
  /** Papers left 보류. */
  maybe: number;
  /** Relevant papers recommended for inclusion. */
  included: number;
  failed: number;
  passed: boolean;
  calls: { decision: number; generative: number };
  inputTokens: number;
  elapsedMs: number;
  error?: string;
}
export interface EvaluationReport {
  projectId: string;
  criteriaVersion: number;
  sample: { relevant: number; irrelevant: number };
  scores: EvaluationScore[];
  /** The mode with the best catch rate among those that pass, or null when none passes. */
  recommended: ScreeningMode | null;
  createdAt: string;
}
/** Missing relevant papers at a higher rate than this fails the configuration. */
export const MAX_MISS_RATE = 0.05;

export function scoreEvaluation(
  config: EvaluationConfig,
  truth: Map<string, boolean>,
  outcomes: Map<string, { recommendation: Recommendation; failed: boolean }>,
): Omit<EvaluationScore, "calls" | "inputTokens" | "elapsedMs"> {
  let relevant = 0, irrelevant = 0, missed = 0, caught = 0, maybe = 0, included = 0, failed = 0;
  for (const [id, isRelevant] of truth) {
    const outcome = outcomes.get(id);
    if (!outcome) continue;
    if (outcome.failed) failed++;
    if (isRelevant) relevant++;
    else irrelevant++;
    if (outcome.recommendation === "maybe") maybe++;
    if (isRelevant && outcome.recommendation === "exclude") missed++;
    if (isRelevant && outcome.recommendation === "include") included++;
    if (!isRelevant && outcome.recommendation === "exclude") caught++;
  }
  const missRate = relevant ? missed / relevant : 0;
  return { mode: config.mode, label: config.label, relevant, irrelevant, missed, missRate, caught, maybe, included, failed, passed: relevant > 0 && missRate <= MAX_MISS_RATE };
}
