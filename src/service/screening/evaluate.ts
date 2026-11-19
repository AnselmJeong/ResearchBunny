import type Database from "../db/sqlite";
import type { Work } from "../../shared/types";
import {
  MODE_NAMES,
  recommend,
  scoreEvaluation,
  type EvaluationReport,
  type EvaluationScore,
  type ScreenResult,
  type ScreeningMode,
  type ScreeningProfile,
} from "../../shared/screening";
import { screenPapers, type ScreenDeps, type ScreenExample, type ScreenPaper } from "./pipeline";
import { screenPaper } from "./store";

/**
 * The evaluation set: the project's archive is what the person kept
 * (relevant), its trash and 제외 what they turned away (not relevant). Only
 * papers with an abstract count, since a paper without one is never judged.
 * The sample is spread evenly over each group, newest decisions first.
 */
export function evaluationSet(db: Database, projectId: string, size: number): { relevant: Work[]; irrelevant: Work[] } {
  const rows = db.prepare(
    `SELECT w.data,json_extract(pw.state,'$.screening') AS screening FROM project_works pw JOIN works w ON w.id=pw.work_id
     WHERE pw.project_id=? AND json_extract(pw.state,'$.screening') IN ('included','excluded','trash')
       AND length(coalesce(json_extract(w.data,'$.abstract'),''))>80
     ORDER BY json_extract(pw.state,'$.updatedAt') DESC`,
  ).all(projectId) as { data: string; screening: string }[];
  const spread = (list: Work[]) => {
    if (list.length <= size) return list;
    const step = list.length / size;
    return Array.from({ length: size }, (_, i) => list[Math.floor(i * step)]);
  };
  const parse = (r: { data: string }) => JSON.parse(r.data) as Work;
  return {
    relevant: spread(rows.filter((r) => r.screening === "included").map(parse)),
    irrelevant: spread(rows.filter((r) => r.screening !== "included").map(parse)),
  };
}

export interface EvaluationRequest {
  profile: ScreeningProfile;
  relevant: Work[];
  irrelevant: Work[];
  modes: ScreeningMode[];
  examples: ScreenExample[];
  signal: AbortSignal;
  onProgress?: (message: string, done: number, total: number) => void;
}

/**
 * Screens the evaluation set with each configuration and scores it against
 * the person's decisions. The two-stage run reuses the decision model's
 * answers from the decision-only run, so each paper is asked once per model.
 */
export async function evaluateScreening(deps: ScreenDeps, request: EvaluationRequest): Promise<EvaluationReport> {
  const { profile } = request;
  const papers: ScreenPaper[] = [...request.relevant, ...request.irrelevant].map(screenPaper);
  const truth = new Map<string, boolean>([...request.relevant.map((w) => [w.id, true] as const), ...request.irrelevant.map((w) => [w.id, false] as const)]);
  // The examples must not give away the answers.
  const titles = new Set(papers.map((p) => p.title.toLowerCase()));
  const examples = request.examples.filter((e) => !titles.has(e.title.toLowerCase()));
  const order: ScreeningMode[] = (["decision", "two-stage", "generative"] as const).filter((m) => request.modes.includes(m));
  const scores: EvaluationScore[] = [];
  let decisionResults: Map<string, ScreenResult> | undefined;
  for (const mode of order) {
    request.signal.throwIfAborted();
    const started = Date.now();
    const label = MODE_NAMES[mode];
    try {
      const reuse = mode === "two-stage" && decisionResults;
      const outcome = await screenPapers(deps, {
        profile,
        papers,
        mode,
        examples,
        fresh: !reuse,
        existing: reuse ? decisionResults : undefined,
        skipCharacter: true,
        signal: request.signal,
        onProgress: (message, done, total) => request.onProgress?.(`${label} · ${message}`, done, total),
      });
      if (mode === "decision") decisionResults = outcome.results;
      const outcomes = new Map([...outcome.results].map(([id, result]) => [id, { recommendation: recommend(profile, result).recommendation, failed: !!result.error }]));
      scores.push({ ...scoreEvaluation({ mode, label }, truth, outcomes), calls: outcome.calls, inputTokens: outcome.inputTokens, elapsedMs: Date.now() - started });
    } catch (error) {
      if (request.signal.aborted) throw error;
      scores.push({
        mode, label, relevant: request.relevant.length, irrelevant: request.irrelevant.length,
        missed: 0, missRate: 0, caught: 0, maybe: 0, included: 0, failed: papers.length, passed: false,
        calls: { decision: 0, generative: 0 }, inputTokens: 0, elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const passing = scores.filter((s) => s.passed && !s.error);
  const best = passing.sort((a, b) => b.caught - a.caught || a.maybe - b.maybe)[0];
  return {
    projectId: profile.projectId,
    criteriaVersion: profile.version,
    sample: { relevant: request.relevant.length, irrelevant: request.irrelevant.length },
    scores: order.map((mode) => scores.find((s) => s.mode === mode)!).filter(Boolean),
    recommended: best?.mode ?? null,
    createdAt: new Date().toISOString(),
  };
}
