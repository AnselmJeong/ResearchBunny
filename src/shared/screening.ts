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
  /**
   * How inclusion criteria combine. "any": each describes one kind of paper the
   * project wants, and meeting one is enough (the default). "all": every one
   * must hold, as in a systematic review's PICO criteria.
   */
  includeMode?: IncludeMode;
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
export type IncludeMode = "any" | "all";
export const INCLUDE_MODE_NAMES: Record<IncludeMode, string> = {
  any: "하나라도 맞으면 포함",
  all: "모두 맞아야 포함",
};
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
    includeMode: "any",
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
  /** Why the paper is excluded or waits, criterion by criterion, in full. */
  hits: string[];
  /** Inclusion criteria the paper clearly meets. */
  matched: string[];
  /**
   * The paper's role for the purpose in force, as a label and a filter: it
   * never changes the recommendation. `fits` is null when the purpose has no
   * role questions or they were not asked.
   */
  role: { fits: boolean | null; label: string; roles: string[] };
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

/**
 * A recommendation in words: `line` for a list row (the deciding reason first),
 * `full` for its hover text (every reason, the matched criteria and the
 * generative model's reason).
 */
export function screenExplanation(screen: Pick<ScreenView, "recommendation" | "hits" | "matched" | "role" | "reason" | "stale">): { line: string; full: string } {
  const why = screen.hits;
  const line = screen.recommendation === "include"
    ? screen.reason || screen.matched.join(" · ")
    : [...why, screen.reason].filter(Boolean).join(" · ");
  const full = [
    `AI ${RECOMMENDATION_NAMES[screen.recommendation]}${screen.stale ? " (기준을 바꾸기 전의 판정)" : ""}`,
    ...why.map((h) => `• ${h}`),
    ...screen.matched.map((m) => `✓ ${m}`),
    ...(screen.role.label ? [`◇ ${screen.role.label}`] : []),
    ...(screen.reason ? [`AI 이유: ${screen.reason}`] : []),
  ].join("\n");
  return { line, full };
}

/** Probability above which an exclusion criterion clearly applies, and below which an inclusion criterion clearly fails. */
export const CLEAR = 0.9;
/** An inclusion criterion is met above this; an exclusion criterion is clear of the paper below CLEAN. */
export const MET = 0.7;
export const CLEAN = 0.4;

const number = (kind: "include" | "exclude", index: number) => `${kind === "include" ? "포함" : "제외"} 기준 ${index + 1}`;

/**
 * Topic relevance from the criterion judgments. Under "any" (the default) a
 * paper that clearly meets one inclusion criterion is relevant, whatever its
 * overall score; only an exclusion criterion that clearly applies overrides
 * that. Exclusion needs a clear violation: an exclusion criterion that
 * clearly applies, or inclusion criteria that clearly fail (every one under
 * "any", any one under "all"). Anything short of that is uncertain, never
 * excluded. `hits` say why in full; `matched` names the inclusion criteria
 * the paper clearly meets.
 */
export function topicOf(
  profile: Pick<ScreeningProfile, "include" | "exclude" | "includeMode">,
  result: Pick<ScreenResult, "criteria" | "relevance">,
): { topic: TopicVerdict; hits: string[]; matched: string[] } {
  const all = profile.includeMode === "all";
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
  const include = profile.include.map((c, i) => ({ ...c, label: number("include", i) }));
  const exclude = profile.exclude.map((c, i) => ({ ...c, label: number("exclude", i) }));
  const matched = include.filter((c) => met(c.id)).map((c) => `${c.label}에 맞음: ${c.text}`);
  const excluded = exclude.filter((c) => applies(c.id)).map((c) => `${c.label}에 해당: ${c.text}`);
  const failing = include.filter((c) => fails(c.id));
  const failed = all
    ? failing.map((c) => `${c.label}에 맞지 않음: ${c.text}`)
    : include.length && failing.length === include.length
      ? ["어느 포함 기준에도 맞지 않음"]
      : [];
  if (excluded.length || failed.length) return { topic: "off", hits: [...excluded, ...failed], matched };
  const relevance = result.relevance;
  const criteria = include.length + exclude.length;
  // With no criterion to go by, only an unrelated score is clear enough to exclude.
  if (!criteria && relevance !== null && relevance <= 0.5) return { topic: "off", hits: ["연구 의도와 무관"], matched };
  // One clearly met alternative is enough: an unclear exclusion or a low overall score does not hold it back.
  if (!all && matched.length) return { topic: "relevant", hits: [], matched };
  const included = !include.length || (all ? include.every((c) => met(c.id)) : matched.length > 0);
  const unclear = exclude.filter((c) => !clean(c.id)).map((c) => `${c.label} 해당 여부 불확실: ${c.text}`);
  const lowRelevance = relevance !== null && relevance < 2;
  if (included && !unclear.length && (relevance === null ? criteria > 0 : !lowRelevance)) return { topic: "relevant", hits: [], matched };
  const hits = [
    ...(included ? [] : all ? include.filter((c) => !met(c.id)).map((c) => `${c.label} 충족 여부 불확실: ${c.text}`) : ["분명히 맞는 포함 기준이 없음"]),
    ...unclear,
    ...(lowRelevance ? [`연구 의도와의 관련성 낮음 (${relevance!.toFixed(1)}/4)`] : []),
  ];
  return { topic: "uncertain", hits, matched };
}

/** How well a paper serves the purpose: its best role, or null when the role questions were not asked. */
export function roleFit(result: Pick<ScreenResult, "roles">, key: string): number | null {
  const answers = result.roles[key]?.answers;
  if (!answers) return null;
  const values = Object.values(answers);
  return values.length ? Math.max(...values) : null;
}
export const ROLE_FIT = 0.4;

/**
 * The recommendation follows the topic alone: whether a paper belongs in the
 * project. The purpose decides which archived papers a piece of writing draws
 * on, so its role is a label and a filter (`roleOf`), not a reason to wait.
 */
export function recommend(profile: ScreeningProfile, result: ScreenResult): { recommendation: Recommendation; hits: string[]; matched: string[] } {
  if (result.error) return { recommendation: "maybe", hits: [`판정 실패: ${result.error}`], matched: [] };
  if (result.basis === "none") return { recommendation: "maybe", hits: ["초록이 없어 판정하지 않음"], matched: [] };
  const { topic, hits, matched } = topicOf(profile, result);
  return { recommendation: topic === "off" ? "exclude" : topic === "uncertain" ? "maybe" : "include", hits, matched };
}

/** The paper's role for the purpose in force: the roles it can play, or that it has none. */
export function roleOf(profile: ScreeningProfile, result: Pick<ScreenResult, "roles">): ScreenView["role"] & { missing: boolean } {
  const questions = roleQuestions(profile);
  const name = profile.purpose === "custom" ? profile.custom.label || PURPOSE_NAMES.custom : PURPOSE_NAMES[profile.purpose];
  const answers = result.roles[purposeKey(profile)]?.answers;
  if (!questions.length) return { fits: null, label: "", roles: [], missing: false };
  if (!answers) return { fits: null, label: "", roles: [], missing: true };
  const roles = questions.filter((q) => (answers[q.id] ?? 0) >= ROLE_FIT).sort((a, b) => answers[b.id] - answers[a.id]).map((q) => q.label);
  return roles.length
    ? { fits: true, label: `${name} 역할: ${roles.join(" · ")}`, roles, missing: false }
    : { fits: false, label: `${name} 목적에서 맡을 역할 없음`, roles: [], missing: false };
}

export function screenView(profile: ScreeningProfile, result: ScreenResult): ScreenView {
  const { recommendation, hits, matched } = recommend(profile, result);
  const { missing: roleMissing, ...role } = roleOf(profile, result);
  const key = purposeKey(profile);
  const answers = result.roles[key]?.answers || {};
  return {
    recommendation,
    topic: result.topic,
    relevance: result.relevance,
    hits,
    matched,
    role,
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
  /** The papers it screened, so the counts can follow later criteria and purpose changes. */
  spec?: ScreeningTarget;
  updatedAt: string;
}
export interface ScreeningSnapshot {
  profile: ScreeningProfile;
  job: ScreeningJob | null;
  evaluation: EvaluationReport | null;
  /** The last screened papers' recommendations under the current criteria and purpose. */
  live: { counts: Record<Recommendation, number>; stale: number; unscreened: number } | null;
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
