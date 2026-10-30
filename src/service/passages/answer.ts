import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, DEFAULT_FILTERS, type AppEvent, type Run } from "../../shared/types";
import type { AnswerRef, AnswerStatement, AnswerStep, PassageAnswer, PassageHit, PassageSearchResult } from "../../shared/passages";
import { rrf } from "../shelf/search";
import type { AIConfig, AIProvider } from "../providers/openai";
import type { PassageSearch } from "./search";

/** Passages one answer may cite, and how many may come from one paper. */
const MAX_EVIDENCE = 20;
const PER_PAPER = 3;
/** Hits taken from each search query before the queries are fused. */
const PER_QUERY = 16;
/** Kept answers, so switching views or asking again does not call the AI twice. */
const CACHE = 20;
/** The renderer waits up to 300 s for one request; both calls fit inside it. */
const PLAN_MS = 60000;
const WRITE_MS = 220000;

const PLAN_INSTRUCTION = "Prepare a search of the body text of the researcher's own library of scientific papers (mostly English) for the question in data. Return 2 to 4 short English search queries, each a phrase or short sentence that a relevant paragraph would match: one restating the whole question, then one for each distinct part, condition, outcome or mechanism it asks about. Use the field's standard terms and spell out an abbreviation once next to it, e.g. \"intermittent theta burst stimulation (iTBS)\". No boolean operators, quotation marks or filters.";
const planSchema = z.object({ queries: z.array(z.string().trim().min(2).max(200)).min(1).max(4) });
const planOutput = z.toJSONSchema(planSchema, { target: "draft-7" });

const WRITE_INSTRUCTION = "Answer the researcher's question using only the numbered evidence passages from their library. Write statements of one or two sentences each, in Korean, keeping standard English technical terms as they are. Begin with a direct answer to the question, then the supporting details. Every statement that reports a finding, number, method or claim cites one to four passages in sources: n is the passage number and quote is an exact contiguous excerpt of that passage, 8 to 40 words copied character for character in its original language (no changes, no ellipses, no translation), that supports the statement. Only an opening or closing statement that sums up statements already cited may have no sources. Never put citation markers in text. Use nothing from outside the passages: a passage's paper (authors, year, title) identifies the study, but its findings are only what the passage text says. Give numbers only as they appear in a cited passage. When passages disagree, say so and cite both sides. Say what kind of evidence a passage reports when it states it (meta-analysis, randomized trial, animal study, review). Set paragraph true on a statement that starts a new paragraph. Set insufficient true when the passages do not answer the main question, and say in missing, in one or two Korean sentences, what evidence is missing; otherwise missing is an empty string.";
const writeSchema = z.object({
  statements: z.array(z.object({
    text: z.string().trim().min(1).max(800),
    sources: z.array(z.object({ n: z.number().int(), quote: z.string().max(600) })).max(4),
    paragraph: z.boolean(),
  })).min(1).max(40),
  insufficient: z.boolean(),
  missing: z.string().max(800),
});
const writeOutput = z.toJSONSchema(writeSchema, { target: "draft-7" });

/** Text as a quote is compared with it: case, width, dashes, quotation marks and spacing folded. */
export function foldText(text: string) {
  return text.normalize("NFKC").toLowerCase()
    .replace(/­/g, "")
    .replace(/[‐-―−]/g, "-")
    .replace(/[“”„‟″]/g, "\"")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
/**
 * A quote counts when it is in the passage after folding. Models still shorten
 * with an ellipsis now and then; each piece around it must then be in the
 * passage, in order.
 */
export function quoteIn(quote: string, text: string) {
  const q = foldText(quote).replace(/^[\s"'.,;:]+|[\s"'.,;:]+$/g, "");
  if (q.replace(/\s/g, "").length < 12) return false;
  const body = foldText(text);
  let from = 0;
  for (const piece of q.split(/\s*(?:\.\.\.|…)\s*/).filter(Boolean)) {
    if (piece.replace(/\s/g, "").length < 6) return false;
    const at = body.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}
/** Numbers worth checking: decimals, percentages and anything past ten. Small counts ("두 연구") are left alone. */
export function checkedNumbers(text: string) {
  return [...new Set((text.match(/\d+(?:[.,]\d+)?/g) || []).filter((n) => /[.,]/.test(n) || Number(n) > 10))];
}
const numbersOf = (text: string) => new Set((foldText(text).match(/\d+(?:[.,]\d+)?/g) || []).flatMap((n) => [n, n.replace(",", ".")]));

const paperLabel = (hit: PassageHit) => {
  const first = hit.authors[0]?.split(/\s+/).at(-1) || "Unknown";
  return `${first}${hit.authors.length > 1 ? " et al." : ""} (${hit.year ?? "n.d."}) ${hit.title}`;
};
const pagesOf = (hit: PassageHit) => (hit.pageEnd > hit.page ? `p. ${hit.page}-${hit.pageEnd}` : `p. ${hit.page}`);

type Search = Pick<PassageSearch, "search">;
type Structured = Pick<AIProvider, "structured">;

/**
 * Answers a question from the shelf's passages: search queries from the
 * question, passages fused over those queries, statements written by the
 * connected AI, and every citation's quote checked against its passage.
 */
export class PassageAnswerer {
  active = new Map<string, AbortController>();
  private cache = new Map<string, PassageAnswer>();
  constructor(
    private search: Search,
    private ai: Structured,
    private config: () => AIConfig,
    private emit: (event: AppEvent) => void,
  ) {}

  cancel(id: string) {
    this.active.get(id)?.abort(new AppError("CANCELLED", "답변을 취소했습니다."));
  }
  stop() {
    for (const id of this.active.keys()) this.cancel(id);
  }

  async ask(id: string, question: string, opts: { revision: string; stamp: number; works?: Set<string>; scope: string; fresh?: boolean }): Promise<PassageAnswer> {
    const config = this.config();
    if (!config.aiEnabled) throw new AppError("AI_DISABLED", "설정에서 AI 연결을 켜야 답변을 만들 수 있습니다. 본문 구절 검색은 그대로 쓸 수 있습니다.");
    const model = config.aiProvider === "codex" ? config.codexModel : config.aiProvider === "claude" ? config.claudeModel : config.aiProvider === "ollama" ? config.ollamaModel : config.model;
    const key = JSON.stringify([question, opts.scope, opts.revision, opts.stamp, config.aiProvider, model]);
    const kept = this.cache.get(key);
    if (kept && !opts.fresh) return kept;
    if (this.active.has(id)) throw new AppError("BUSY", "이 질문의 답변을 이미 만들고 있습니다.");
    const controller = new AbortController();
    this.active.set(id, controller);
    const signal = controller.signal;
    const started = Date.now();
    const progress = (step: AnswerStep, message: string) => this.emit({ type: "answer", id, step, message });
    try {
      // 1. Search queries. A malformed plan falls back to the question alone; a provider error ends here.
      progress("plan", "질문을 검색어로 나누는 중");
      let planned: string[] = [];
      try {
        const raw = await this.ai.structured(this.run("passage_plan", question), "passage_plan", planOutput, PLAN_INSTRUCTION, { question }, AbortSignal.any([signal, AbortSignal.timeout(PLAN_MS)]), false);
        planned = planSchema.parse(raw).queries;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof AppError && error.code === "AI_FORMAT") && !(error instanceof z.ZodError)) throw error;
      }
      const queries = [...new Map([question, ...planned].map((q) => [q.toLowerCase(), q])).values()];

      // 2. Passages for every query, fused by rank; a few per paper so one long paper cannot fill the evidence.
      progress("search", `본문 구절 찾는 중 · 검색어 ${queries.length}개`);
      const results: PassageSearchResult[] = [];
      for (const q of queries) {
        signal.throwIfAborted();
        results.push(await this.search.search(q, { limit: PER_QUERY, perWork: PER_PAPER, revision: opts.revision, works: opts.works, signal }));
      }
      const hits = new Map<number, PassageHit>();
      for (const r of results) for (const h of r.hits) if (!hits.has(h.passageId)) hits.set(h.passageId, h);
      const fused = [...rrf(results.map((r) => r.hits.map((h) => String(h.passageId)))).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => hits.get(Number(id))!);
      const evidence = this.fit(question, fused, config.aiMaxInputTokens);
      const base = { question, queries, semantic: results[0].semantic, coverage: results[0].coverage, provider: config.aiProvider, model, createdAt: new Date().toISOString() };
      if (!evidence.length) {
        const empty: PassageAnswer = { ...base, statements: [], refs: [], unused: [], insufficient: true, missing: "서고 본문에서 이 질문과 관련된 구절을 찾지 못했습니다.", dropped: 0, elapsedMs: Date.now() - started };
        return empty;
      }

      // 3. Statements from the passages only.
      progress("write", `답변 쓰는 중 · 구절 ${evidence.length}개`);
      const raw = await this.ai.structured(this.run("passage_answer", question), "passage_answer", writeOutput, WRITE_INSTRUCTION, this.payload(question, evidence), AbortSignal.any([signal, AbortSignal.timeout(WRITE_MS)]), false);
      const written = writeSchema.safeParse(raw);
      if (!written.success) throw new AppError("AI_FORMAT", "AI 답변 형식이 맞지 않았습니다. 다시 시도하세요.", true);

      // 4. Citations count only with a quote found in their passage.
      progress("check", "인용 확인 중");
      const answer: PassageAnswer = { ...base, ...this.check(question, written.data, evidence), elapsedMs: Date.now() - started };
      this.cache.set(key, answer);
      while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
      return answer;
    } catch (error) {
      if (signal.aborted) throw signal.reason instanceof AppError ? signal.reason : new AppError("CANCELLED", "답변을 취소했습니다.");
      throw error;
    } finally {
      this.active.delete(id);
    }
  }

  private payload(question: string, evidence: PassageHit[]) {
    return {
      question,
      evidence: evidence.map((hit, i) => ({ n: i + 1, paper: paperLabel(hit), section: hit.section, pages: pagesOf(hit), text: hit.text })),
    };
  }
  /** As many passages as the AI input limit takes (UTF-8 bytes, as `structured` counts them), in rank order. */
  private fit(question: string, ranked: PassageHit[], limit: number) {
    const perPaper = new Map<string, number>();
    const chosen: PassageHit[] = [];
    const overhead = Buffer.byteLength(WRITE_INSTRUCTION + JSON.stringify(writeOutput)) + 2600;
    for (const hit of ranked) {
      if (chosen.length >= MAX_EVIDENCE) break;
      if ((perPaper.get(hit.workId) || 0) >= PER_PAPER) continue;
      if (overhead + Buffer.byteLength(JSON.stringify(this.payload(question, [...chosen, hit]))) > limit) {
        if (!chosen.length) throw new AppError("BUDGET", `구절 하나도 AI 입력 상한(${Math.round(limit / 1000)} KB)에 들어가지 않습니다. 설정에서 AI 입력 상한을 늘리세요.`);
        break;
      }
      perPaper.set(hit.workId, (perPaper.get(hit.workId) || 0) + 1);
      chosen.push(hit);
    }
    return chosen;
  }
  /** Keeps citations whose quote is in the passage, numbers refs by first use, and marks numbers no cited passage holds. */
  private check(question: string, written: z.infer<typeof writeSchema>, evidence: PassageHit[]) {
    const numberOf = new Map<number, number>();
    const quotes = new Map<number, string[]>();
    let dropped = 0;
    const statements: AnswerStatement[] = written.statements.map((s) => {
      const refs: number[] = [];
      const allowed = numbersOf(question);
      for (const source of s.sources) {
        const hit = evidence[source.n - 1];
        if (!hit || !quoteIn(source.quote, hit.text)) {
          dropped++;
          continue;
        }
        if (!numberOf.has(source.n)) numberOf.set(source.n, numberOf.size + 1);
        const n = numberOf.get(source.n)!;
        if (!refs.includes(n)) refs.push(n);
        quotes.set(source.n, [...(quotes.get(source.n) || []), source.quote]);
        for (const number of numbersOf(`${hit.text} ${hit.title} ${hit.year ?? ""}`)) allowed.add(number);
      }
      return {
        text: s.text,
        paragraph: s.paragraph,
        refs,
        status: refs.length ? "cited" : s.sources.length ? "unverified" : "uncited",
        unsupported: refs.length ? checkedNumbers(s.text).filter((n) => !allowed.has(n) && !allowed.has(n.replace(",", "."))) : [],
      };
    });
    const refs: AnswerRef[] = [...numberOf].sort((a, b) => a[1] - b[1]).map(([source, n]) => ({ n, hit: evidence[source - 1], quotes: quotes.get(source) || [] }));
    const unused = evidence.filter((_, i) => !numberOf.has(i + 1));
    return { statements, refs, unused, insufficient: written.insufficient, missing: written.missing.trim(), dropped };
  }

  /** Each call is its own budget run, as in 수신함 정리. */
  private run(name: string, question: string): Run {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), projectId: "shelf", mode: "ai", query: question.slice(0, 200), seedProfileId: null,
      inputIds: [], filters: DEFAULT_FILTERS, status: "running", createdAt: now, updatedAt: now,
      calls: 0, maxCalls: 1, maxCandidates: 0, total: null, count: 0, message: "", tasks: [], rankingVersion: name,
    };
  }
}
