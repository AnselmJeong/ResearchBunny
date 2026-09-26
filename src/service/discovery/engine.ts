import { randomUUID } from "node:crypto";
import type { Library } from "../db/database";
import { OpenAlex, type Page } from "../providers/openalex";
import {
  AppError,
  now,
  type Run,
  type Task,
  type Evidence,
  type AppEvent,
  type Work,
} from "../../shared/types";
import {
  normalizeDoi,
  normalizeOpenAlex,
  relatedness,
} from "../../shared/domain";
import type { Input } from "../../shared/contracts";
import type { AIProvider } from "../providers/openai";
const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
export class Discovery {
  active = new Map<string, AbortController>();
  constructor(
    public library: Library,
    private oa: OpenAlex,
    private emit: (event: AppEvent) => void,
    private ai?: AIProvider,
  ) {}
  start(input: Input<"startRun">): Run {
    this.library.project(input.projectId);
    if (this.active.size)
      throw new AppError(
        "BUSY",
        "진행 중인 탐색이 끝나거나 취소한 뒤 실행하세요.",
      );
    if (!["search", "ai"].includes(input.mode) && !input.ids.length)
      throw new AppError("NO_SEEDS", "확장할 논문을 먼저 선택하세요.");
    if (
      ["commonReferences", "commonCiting"].includes(input.mode) &&
      input.ids.length < 2
    )
      throw new AppError("NO_SEEDS", "공통 관계는 2편 이상을 선택하세요.");
    if (["search", "ai"].includes(input.mode) && !input.query.trim())
      throw new AppError("EMPTY_QUERY", "검색어나 연구 질문을 입력하세요.");
    const seed = this.library.seedHistory(input.projectId)[0];
    const run: Run = {
      id: randomUUID(),
      projectId: input.projectId,
      mode: input.mode,
      query: input.query,
      seedProfileId: input.mode === "ai" ? null : seed?.id || null,
      inputIds: [...new Set(input.ids)],
      filters: input.filters,
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
      calls: 0,
      maxCalls: 40,
      maxCandidates: input.mode === "ai" ? 500 : 1000,
      total: null,
      count: 0,
      message: "검색을 준비하고 있습니다.",
      tasks: [],
      rankingVersion: "tfidf-topic-v1",
      phase: "hydrate",
      parentId: input.parentId,
    };
    if (input.mode === "search") {
      const identifier =
        normalizeOpenAlex(input.query) || normalizeDoi(input.query);
      run.tasks = [
        identifier
          ? { kind: "lookup", query: identifier, origin: "검색" }
          : {
              kind: "search",
              query: input.query,
              origin: input.semantic ? "의미 검색" : "키워드 검색",
              cursor: "*",
              sort:
                input.sort === "year"
                  ? "publication_date:desc"
                  : input.sort === "citations"
                    ? "cited_by_count:desc"
                    : undefined,
            },
      ];
      run.phase = "collect";
    } else if (input.mode === "ai") run.phase = "ai-plan";
    else
      for (const id of run.inputIds) {
        const w = this.library.get(id);
        if ((!w.openalex || w.references === null) && w.doi)
          run.tasks.push({
            kind: "lookup",
            query: w.doi,
            seedId: id,
            origin: "서지 확인",
          });
      }
    this.library.saveRun(run);
    void this.execute(run.id);
    return run;
  }
  control(id: string, action: "cancel" | "resume" | "more") {
    if (action === "cancel") {
      this.active.get(id)?.abort();
      const r = this.library.run(id);
      r.status = "cancelled";
      r.message = "취소 요청됨 · 저장된 후보는 유지됩니다.";
      this.library.saveRun(r);
      this.emit({ type: "changed" });
      return;
    }
    if (this.active.size)
      throw new AppError("BUSY", "현재 작업이 끝난 뒤 재개하세요.");
    const run = this.library.run(id);
    if (action === "more") {
      for (const task of run.tasks)
        if (task.cursor && ["cites", "search"].includes(task.kind))
          task.done = false;
    }
    run.maxCalls = run.calls + 40;
    run.maxCandidates = run.count + (run.mode === "ai" ? 500 : 1000);
    run.status = "queued";
    this.library.saveRun(run);
    void this.execute(id);
  }
  makeTasks(run: Run): Task[] {
    const seeds = run.inputIds.map((id) => this.library.get(id));
    const perSeed = seeds.map((w) => {
      const result: Task[] = [];
      if (!w.openalex) return result;
      if (["references", "commonReferences", "related"].includes(run.mode))
        for (const ids of chunks(w.references || [], 100))
          result.push({ kind: "batch", ids, seedId: w.id, origin: "참고문헌" });
      if (run.mode === "related")
        for (const ids of chunks(w.related, 100))
          result.unshift({
            kind: "batch",
            ids,
            seedId: w.id,
            origin: "OpenAlex 관련 주제",
          });
      if (["citedBy", "commonCiting", "related"].includes(run.mode)) {
        result.unshift({
          kind: "cites",
          query: w.openalex,
          seedId: w.id,
          origin: "후속 인용",
          cursor: "*",
          sort: "cited_by_count:desc",
        });
        result.push({
          kind: "cites",
          query: w.openalex,
          seedId: w.id,
          origin: "최근 후속 인용",
          cursor: "*",
          sort: "publication_date:desc",
        });
      }
      return result;
    });
    const tasks: Task[] = [];
    while (perSeed.some((t) => t.length))
      for (const group of perSeed) {
        const task = group.shift();
        if (task) tasks.push(task);
      }
    if (run.mode === "related") {
      const anchor = this.library.seedById(run.seedProfileId);
      const query = anchor?.question || run.query || seeds[0]?.title;
      if (query)
        tasks.unshift({
          kind: "search",
          query: query.slice(0, 2000),
          origin: "초기 관심 검색",
          cursor: "*",
        });
    }
    return tasks;
  }
  async fetchTask(
    task: Task,
    signal: AbortSignal,
    onCall: () => void,
  ): Promise<Page> {
    if (task.kind === "lookup")
      return this.oa.lookup(task.query!, signal, onCall);
    if (task.kind === "batch")
      return this.oa.page(
        { filter: `openalex:${task.ids!.join("|")}`, per_page: "100" },
        signal,
        onCall,
      );
    if (task.kind === "cites")
      return this.oa.page(
        {
          filter: `cites:${task.query}`,
          cursor: task.cursor || "*",
          ...(task.sort ? { sort: task.sort } : {}),
        },
        signal,
        onCall,
      );
    return this.oa.page(
      {
        [task.origin === "의미 검색" ? "search.semantic" : "search"]:
          task.query!,
        ...(task.origin === "의미 검색" ? {} : { cursor: task.cursor || "*" }),
        ...(task.sort ? { sort: task.sort } : {}),
      },
      signal,
      onCall,
    );
  }
  async execute(id: string) {
    const controller = new AbortController();
    this.active.set(id, controller);
    const signal = controller.signal;
    const run = this.library.run(id);
    run.status = "running";
    this.library.saveRun(run);
    this.emit({ type: "progress", runId: id });
    const onCall = () => {
      signal.throwIfAborted();
      if (run.calls >= run.maxCalls)
        throw new AppError("BUDGET", "이번 탐색의 호출 예산에 도달했습니다.");
      run.calls++;
      this.library.usage("openalex", id);
      this.library.saveRun(run);
    };
    try {
      if (run.phase === "ai-plan") {
        if (!this.ai)
          throw new AppError("AI_DISABLED", "설정에서 AI 기능을 활성화하세요.");
        run.message = "연구 질문을 검색식으로 정리하고 있습니다.";
        this.library.saveRun(run);
        this.emit({ type: "progress", runId: id });
        const plan = await this.ai.plan(run, signal);
        run.ai = { ...run.ai, plan };
        run.tasks = plan.queries.slice(0, 8).map((query) => ({
          kind: "search",
          query,
          origin: "AI 검색 계획",
          cursor: "*",
        }));
        run.phase = "collect";
        this.library.saveRun(run);
      }
      while (true) {
        signal.throwIfAborted();
        const task = run.tasks.find((t) => !t.done);
        if (!task) {
          if (run.mode === "ai" && !run.ai?.neighborsCollected) {
            this.rank(run);
            const representatives = this.library
              .candidates(run.id)
              .slice(0, 3)
              .map((e) => e.work);
            for (const representative of representatives) {
              if (representative.references?.length)
                run.tasks.push({
                  kind: "batch",
                  ids: representative.references.slice(0, 50),
                  seedId: representative.id,
                  origin: "AI 후보의 기반 문헌",
                });
              if (representative.openalex)
                run.tasks.push({
                  kind: "cites",
                  query: representative.openalex,
                  seedId: representative.id,
                  origin: "AI 후보의 최근 후속",
                  cursor: "*",
                  sort: "publication_date:desc",
                });
            }
            run.ai = {
              ...run.ai,
              neighborsCollected: true,
              neighborIds: representatives.map((w) => w.id),
            };
            this.library.saveRun(run);
            continue;
          }
          if (run.phase === "hydrate") {
            run.tasks.push(...this.makeTasks(run));
            run.phase = "collect";
            this.library.saveRun(run);
            continue;
          }
          break;
        }
        if (run.count >= run.maxCandidates) {
          if (run.mode === "ai") {
            run.ai = { ...run.ai, partial: true };
            break;
          }
          throw new AppError("BUDGET", "이번 탐색의 후보 상한에 도달했습니다.");
        }
        run.message = `${task.origin} 조회 중 · 후보 ${run.count}편 · API ${run.calls}/${run.maxCalls}회`;
        this.library.saveRun(run);
        this.emit({ type: "progress", runId: id });
        const page =
          task.pendingPage || (await this.fetchTask(task, signal, onCall));
        signal.throwIfAborted();
        this.library.transaction(() => {
          let processed = 0;
          for (const input of page.works) {
            if (run.count >= run.maxCandidates) break;
            processed++;
            try {
              const { work } = this.library.upsert(input);
              if (run.phase === "hydrate") continue;
              const evidence: Evidence = {
                origins: [task.origin + (page.cached ? " · 캐시" : "")],
                seedIds: task.seedId ? [task.seedId] : [],
                sharedIds: [],
                denominator:
                  run.mode === "ai"
                    ? (run.ai?.neighborIds as string[] | undefined)?.length || 0
                    : run.inputIds.length,
                relation: run.mode,
                score: null,
                reasons: [],
                hidden: [],
                deferred: false,
                scope: `확인 시점 ${page.fetchedAt} · 확보한 이웃 안에서 계산`,
              };
              this.library.candidate(run, work, evidence);
              run.count = (
                this.library.db
                  .prepare(
                    "SELECT count(*) AS n FROM candidates WHERE run_id=?",
                  )
                  .get(run.id) as { n: number }
              ).n;
            } catch (error) {
              if (
                error instanceof AppError &&
                error.code === "IDENTITY_CONFLICT"
              ) {
                run.message = "일부 식별자 충돌 문헌은 건너뛰었습니다.";
                run.ai = {
                  ...run.ai,
                  identityConflicts: Number(run.ai?.identityConflicts || 0) + 1,
                };
              } else throw error;
            }
          }
          const remaining = page.works.slice(processed);
          task.pendingPage = remaining.length
            ? { ...page, works: remaining }
            : undefined;
          if (!remaining.length) task.pages = (task.pages || 0) + 1;
          task.cursor = page.cursor || undefined;
          task.total = page.total ?? undefined;
          task.done = remaining.length === 0;
          if (run.mode === "search") run.total = page.total;
          this.library.saveRun(run);
        });
        this.rank(run);
        this.emit({ type: "changed", runId: id });
      }
      this.rank(run);
      if (run.mode === "ai" && !run.ai?.evaluated && this.ai) {
        run.message = "확인된 후보를 역할별로 평가하고 있습니다.";
        this.library.saveRun(run);
        this.emit({ type: "progress", runId: id });
        await this.ai.evaluate(run, signal);
        run.ai = { ...run.ai, evaluated: true };
      }
      const unresolved = run.inputIds.filter(
        (id) => !this.library.get(id).openalex,
      ).length;
      run.status = "completed";
      run.message = `${run.count}편 확인${run.tasks.some((t) => t.cursor) ? " · 추가 조회할 결과가 있습니다." : ""}${run.ai?.partial ? " · 후보 상한 내 부분 결과" : ""}${unresolved ? ` · 식별자 없는 출발 문헌 ${unresolved}편은 미조회` : ""}${run.ai?.identityConflicts ? ` · 식별자 충돌 ${run.ai.identityConflicts}건 제외` : ""}`;
    } catch (error) {
      const e = error instanceof AppError ? error : null;
      run.status = signal.aborted
        ? "cancelled"
        : e && ["BUDGET", "DAILY_BUDGET", "RATE_LIMIT"].includes(e.code)
          ? "paused_budget"
          : "failed";
      run.message = signal.aborted
        ? "취소됨 · 이미 확인한 후보는 유지됩니다."
        : e?.message ||
          "작업을 완료하지 못했습니다. 저장된 결과에서 재개할 수 있습니다.";
      if (e?.code === "RATE_LIMIT")
        run.retryAt = new Date(Date.now() + 60000).toISOString();
      this.rank(run);
    } finally {
      this.library.saveRun(run);
      this.active.delete(id);
      this.emit({ type: "changed", runId: id });
    }
  }
  rank(run: Run) {
    const entries = this.library.candidates(run.id);
    const profile = this.library.seedById(run.seedProfileId);
    const anchors = profile?.ids.map((id) => this.library.get(id)) || [];
    const basis = run.inputIds.map((id) => this.library.get(id));
    const related = relatedness(
      entries.map((e) => e.work),
      anchors,
      profile?.question || run.query,
    );
    const citing = new Map<string, Work[]>();
    for (const entry of entries)
      for (const ref of entry.work.references || []) {
        const arr = citing.get(ref) || [];
        arr.push(entry.work);
        citing.set(ref, arr);
      }
    this.library.transaction(() => {
      for (const { work, evidence } of entries) {
        const content = related.get(work.id)!;
        evidence.score = content.score;
        evidence.deferred = content.deferred;
        if (["references", "commonReferences"].includes(run.mode))
          evidence.seedIds = basis
            .filter(
              (s) => work.openalex && s.references?.includes(work.openalex),
            )
            .map((s) => s.id);
        else if (["citedBy", "commonCiting"].includes(run.mode))
          evidence.seedIds = basis
            .filter((s) => s.openalex && work.references?.includes(s.openalex))
            .map((s) => s.id);
        const references = new Set(work.references || []);
        evidence.sharedIds = [
          ...new Set(
            basis.flatMap((s) =>
              (s.references || []).filter((ref) => references.has(ref)),
            ),
          ),
        ];
        evidence.reasons = [];
        if (evidence.seedIds.length)
          evidence.reasons.push(
            `${evidence.denominator}편 중 ${evidence.seedIds.length}편과 ${run.mode.includes("References") || run.mode === "references" ? "참고문헌" : "발견"} 연결`,
          );
        if (evidence.sharedIds.length)
          evidence.reasons.push(
            `출발 문헌과 공유하는 참고문헌 ${evidence.sharedIds.length}편`,
          );
        if (work.openalex) {
          const cociting = basis.flatMap((s) =>
            s.openalex
              ? (citing.get(work.openalex!) || [])
                  .filter((c) => c.references?.includes(s.openalex!))
                  .map((c) => c.openalex!)
              : [],
          );
          evidence.coCitingIds = [...new Set(cociting)];
          if (cociting.length)
            evidence.reasons.push(
              `확보한 이웃 내 공동인용 문헌 ${new Set(cociting).size}편`,
            );
        }
        if (content.seedIds.length)
          evidence.reasons.push(
            `초기 관심 ${content.seedIds.length}편과 텍스트·주제 겹침`,
          );
        if (content.deferred)
          evidence.reasons.push("초록 부족 · 관련성 판단 보류");
        if (work.references === null)
          evidence.reasons.push("참고문헌 정보 미제공");
        const score =
          (content.score || 0) +
          Math.min(0.15, evidence.seedIds.length * 0.025) +
          Math.min(0.03, Math.log1p(work.citations || 0) / 400);
        this.library.updateEvidence(run.id, work.id, evidence, score);
      }
    });
  }
}
