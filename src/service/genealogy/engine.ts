import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AppError, now, type AppEvent, type Work } from "../../shared/types";
import {
  STEPS,
  STEP_NAMES,
  type Genealogy,
  type GenealogyCard,
  type GenealogyJob,
  type GenealogyPaper,
  type GenealogySettings,
  type GenealogyStep,
  type GenealogyView,
  type PaperType,
} from "../../shared/genealogy";
import type { Library } from "../db/database";
import type { OpenAlex } from "../providers/openalex";
import type { PdfDownloads } from "../fulltext/jobs";
import { extractPdf, verifyPdf } from "../interchange/pdf";
import { fetchPublicationTypes } from "../search/pubmed-search";
import type { FetchLike } from "../search/web-search";
import { GenealogyAI, Meter } from "./llm";
import { EMPTY_OUTPUTS, GenealogyStore } from "./store";
import { jatsText, pdfText, readingText, type PaperText } from "./sections";
import { europePmcIds, europePmcXml, pmcidOf, typeFromMetadata } from "./sources";
import { CARD_SCHEMA, MERGE_INSTRUCTION, cardInput, cardInstruction, cardMarkdown, parseCard, splitText } from "./cards";

export interface EngineDeps {
  db: Library;
  store: GenealogyStore;
  ai: GenealogyAI;
  oa: OpenAlex;
  downloads: PdfDownloads;
  workerPath: string;
  emit: (event: AppEvent) => void;
  pubmedKey: () => string | undefined;
  /** False while a configured shelf is offline: downloads would have nowhere to go. */
  shelfWritable: () => Promise<boolean>;
  /** Other work that must not overlap a download (discovery, imports, sorting). */
  busy: () => boolean;
  fetcher?: FetchLike;
  tools?: () => { pandoc: string | null; typst: string | null };
}

/** Thrown inside a step to stop the job without calling it a failure. */
class Pause extends Error {}

const TEXT_VERSION = 1;
interface StoredText extends PaperText {
  version: number;
}

export class GenealogyEngine {
  active = new Map<string, AbortController>();
  constructor(private deps: EngineDeps) {
    for (const g of deps.store.all())
      if (g.job?.status === "running") {
        g.job = { ...g.job, status: "interrupted", message: "앱 종료로 중단되었습니다. 저장된 지점에서 이어서 실행할 수 있습니다." };
        deps.store.save(g);
      }
  }

  get store() {
    return this.deps.store;
  }

  view(id: string): GenealogyView {
    const g = this.store.get(id);
    const collection = this.deps.db.collections(g.projectId).find((c) => c.id === g.collectionId);
    return {
      genealogy: g,
      collectionName: collection?.name ?? "",
      papers: this.store.papers(id),
      candidates: this.store.candidates(id),
      branches: this.store.state(id, "branches") ?? [],
      outline: this.store.state(id, "outline") ?? null,
      checks: this.store.state(id, "checks") ?? [],
      outputs: this.store.state(id, "outputs") ?? EMPTY_OUTPUTS,
      cards: Object.fromEntries(this.store.cards(id)),
      tools: this.deps.tools?.() ?? { pandoc: null, typst: null },
    };
  }

  create(input: { projectId: string; collectionId: string; title: string; settings: GenealogySettings; workspace?: string }) {
    const g = this.store.create(input);
    this.sync(g);
    g.startSize = this.store.papers(g.id, true).length;
    this.store.save(g);
    return g;
  }

  update(id: string, patch: { title?: string; settings?: Partial<GenealogySettings> }) {
    const g = this.store.get(id);
    if (patch.title?.trim()) g.title = patch.title.trim();
    if (patch.settings) g.settings = { ...g.settings, ...patch.settings, routes: { ...g.settings.routes, ...patch.settings.routes } };
    this.store.save(g);
    this.changed(id);
    return g;
  }

  remove(id: string) {
    if (this.active.has(id)) throw new AppError("BUSY", "진행 중인 계보 작업을 취소한 뒤 삭제하세요.");
    this.store.remove(id);
  }

  /** The reader's override of a paper's type; its card is read again. */
  setType(id: string, workId: string, type: PaperType) {
    const paper = this.store.paper(id, workId);
    if (!paper) throw new AppError("NOT_FOUND", "계보 문헌을 찾을 수 없습니다.");
    if (paper.type !== type) {
      paper.type = type;
      paper.typeSource = "user";
      paper.typeReason = "사용자가 지정";
      if (paper.cardStatus === "done") paper.cardStatus = "stale";
      this.store.savePaper(id, paper);
      this.changed(id);
    }
  }

  start(id: string, step: GenealogyStep | "continue", auto: boolean) {
    if (this.active.size) throw new AppError("BUSY", "진행 중인 계보 작업이 끝나거나 취소한 뒤 실행하세요.");
    const g = this.store.get(id);
    const first = step === "continue" ? (STEPS.find((s) => !g.completed[s]) ?? "render") : step;
    g.job = { step: first, status: "running", message: `${STEP_NAMES[first]} 준비 중`, done: 0, total: 0, calls: 0, auto, startedAt: now(), updatedAt: now() };
    this.store.save(g);
    const control = new AbortController();
    this.active.set(id, control);
    void this.execute(id, first, auto, control.signal).finally(() => {
      this.active.delete(id);
      this.changed(id);
    });
    return g;
  }

  cancel(id: string) {
    this.active.get(id)?.abort();
  }

  close() {
    for (const control of this.active.values()) control.abort();
  }

  private changed(id: string) {
    this.deps.emit({ type: "genealogy", id });
  }

  /** Saves the job's progress for the workspace view. */
  private progress(g: Genealogy, patch: Partial<GenealogyJob>) {
    if (!g.job) return;
    g.job = { ...g.job, ...patch, updatedAt: now() };
    this.store.save(g);
    this.changed(g.id);
  }

  private async execute(id: string, first: GenealogyStep, auto: boolean, signal: AbortSignal) {
    const g = this.store.get(id);
    const meter = new Meter({ maxCalls: g.settings.maxCalls, maxInputBytesPerCall: 900_000 });
    let step = first;
    try {
      while (true) {
        signal.throwIfAborted();
        this.progress(g, { step, status: "running", message: `${STEP_NAMES[step]} 시작`, done: 0, total: 0 });
        const summary = await this.run(g, step, signal, meter);
        g.completed[step] = now();
        this.progress(g, { calls: meter.calls, message: `${STEP_NAMES[step]} 완료${summary ? ` · ${summary}` : ""}` });
        const next = STEPS[STEPS.indexOf(step) + 1];
        if (!auto || !next || !this.implemented(next)) break;
        if (step === "outline" && g.settings.pauseAtOutline && !g.outlineApproved) {
          this.progress(g, { status: "paused", message: "목차를 확인하고 승인하면 집필을 시작합니다." });
          return;
        }
        step = next;
      }
      this.progress(g, { status: "completed", calls: meter.calls });
    } catch (error) {
      const e = error instanceof AppError ? error : null;
      if (signal.aborted) this.progress(g, { status: "cancelled", calls: meter.calls, message: "취소됨 · 이미 만든 결과는 유지됩니다." });
      else if (error instanceof Pause || e?.code === "BUDGET")
        this.progress(g, { status: "paused", calls: meter.calls, message: error instanceof Error ? error.message : "일시정지" });
      else
        this.progress(g, {
          status: "failed",
          calls: meter.calls,
          message: e?.message || (error instanceof Error ? `작업을 완료하지 못했습니다: ${error.message}` : "작업을 완료하지 못했습니다."),
        });
    }
  }

  /** Steps the engine can run; later milestones add theirs. */
  protected implemented(step: GenealogyStep) {
    return step === "prepare" || step === "cards";
  }

  /** Runs one step; a returned line is shown with its completion. */
  protected async run(g: Genealogy, step: GenealogyStep, signal: AbortSignal, meter: Meter): Promise<string | void> {
    if (step === "prepare") return this.prepare(g, signal, meter);
    if (step === "cards") return this.cards(g, signal, meter);
    throw new AppError("NOT_READY", `${STEP_NAMES[step]} 단계는 아직 사용할 수 없습니다.`);
  }

  // --- prepare: corpus, metadata, types, full text, reading text ---

  /** Brings the paper rows in line with the collection: new members join, departed ones are set aside with their cards. */
  sync(g: Genealogy) {
    const members = new Set(this.store.collectionIds(g));
    const rows = new Map(this.store.papers(g.id).map((p) => [p.workId, p]));
    this.deps.db.transaction(() => {
      for (const workId of members) {
        const prior = rows.get(workId) ?? null;
        this.store.savePaper(g.id, this.store.paperFrom(this.deps.db.get(workId), prior, "collection", { included: true }));
      }
      for (const [workId, paper] of rows)
        if (!members.has(workId) && paper.included) this.store.savePaper(g.id, { ...paper, included: false });
    });
  }

  private async prepare(g: Genealogy, signal: AbortSignal, meter: Meter) {
    this.sync(g);
    await mkdir(g.workspace, { recursive: true });
    await this.hydrate(g, signal);
    await this.findPmc(g, signal);
    await this.classify(g, signal, meter);
    if (g.settings.fetchPdfs) await this.fetchPdfs(g, signal);
    await this.readTexts(g, signal);
  }

  /** OpenAlex records for papers that lack their reference lists, in batches of up to 100. */
  private async hydrate(g: Genealogy, signal: AbortSignal) {
    const works = this.store.papers(g.id, true).map((p) => this.deps.db.get(p.workId));
    const missing = works.filter((w) => w.references === null || !w.openalex);
    if (!missing.length) return;
    const byOpenAlex = missing.filter((w) => w.openalex).map((w) => w.openalex!);
    const byDoi = missing.filter((w) => !w.openalex && w.doi).map((w) => w.doi!);
    const batches: string[] = [];
    for (let i = 0; i < byOpenAlex.length; i += 100) batches.push(`openalex:${byOpenAlex.slice(i, i + 100).join("|")}`);
    for (let i = 0; i < byDoi.length; i += 50) batches.push(`doi:${byDoi.slice(i, i + 50).map((d) => `https://doi.org/${d}`).join("|")}`);
    let done = 0;
    this.progress(g, { message: `OpenAlex 서지 보강 · ${missing.length}편`, done: 0, total: batches.length });
    for (const filter of batches) {
      signal.throwIfAborted();
      try {
        const page = await this.deps.oa.page({ filter, per_page: "100" }, signal, () => {});
        this.deps.db.transaction(() => {
          for (const work of page.works) {
            try {
              this.deps.db.upsert(work);
            } catch (error) {
              if (!(error instanceof AppError && error.code === "IDENTITY_CONFLICT")) throw error;
            }
          }
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof AppError && ["RATE_LIMIT", "DAILY_BUDGET"].includes(error.code)) throw new Pause(`OpenAlex 사용 한도: ${error.message}`);
        // A failed batch leaves those papers as they were; the rest of the job does not need it.
      }
      this.progress(g, { done: ++done });
    }
    this.sync(g);
  }

  /** Which papers Europe PMC can serve as structured full text; each paper is asked about once. */
  private async findPmc(g: Genealogy, signal: AbortSignal) {
    const papers = this.store.papers(g.id, true).filter((p) => !p.pmcChecked);
    if (!papers.length) return;
    this.progress(g, { message: `Europe PMC 공개 전문 확인 · ${papers.length}편`, done: 0, total: 0 });
    let found: Map<string, string>;
    try {
      found = await europePmcIds(papers.map((p) => this.deps.db.get(p.workId)), signal, this.deps.fetcher);
    } catch {
      signal.throwIfAborted();
      return;
    }
    for (const paper of papers) {
      const work = this.deps.db.get(paper.workId);
      paper.pmcid = found.get(paper.workId) ?? pmcidOf(work);
      paper.pmcChecked = true;
      this.store.savePaper(g.id, paper);
    }
  }

  private async classify(g: Genealogy, signal: AbortSignal, meter: Meter) {
    const papers = this.store.papers(g.id, true).filter((p) => p.typeSource !== "user");
    if (!papers.length) return;
    const works = new Map(papers.map((p) => [p.workId, this.deps.db.get(p.workId)]));
    let pubtypes = new Map<string, string[]>();
    const pmids = [...works.values()].map((w) => w.pmid).filter((x): x is string => !!x);
    if (pmids.length) {
      this.progress(g, { message: `PubMed 출판 유형 확인 · ${pmids.length}편`, done: 0, total: 0 });
      try {
        pubtypes = await fetchPublicationTypes(pmids, { apiKey: this.deps.pubmedKey(), signal, fetchFn: this.deps.fetcher });
      } catch {
        if (signal.aborted) signal.throwIfAborted();
      }
    }
    for (const paper of papers) {
      const work = works.get(paper.workId)!;
      const found = typeFromMetadata(work, work.pmid ? pubtypes.get(work.pmid) : undefined);
      if (found && paper.typeSource !== "ai") Object.assign(paper, { type: found.type, typeSource: "metadata", typeReason: found.reason });
    }
    // The model sees every paper once: it fills the types records leave open and marks peripheral papers.
    const pending = papers.filter((p) => p.typeSource !== "ai");
    const schema = {
      type: "object",
      properties: {
        papers: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" }, type: { type: "string", enum: ["R", "M", "O", "P"] }, reason: { type: "string" } },
            required: ["key", "type", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["papers"],
      additionalProperties: false,
    };
    for (let i = 0; i < pending.length; i += 25) {
      signal.throwIfAborted();
      const batch = pending.slice(i, i + 25);
      this.progress(g, { message: `문헌 유형 판정 · ${Math.min(i + 25, pending.length)}/${pending.length}편`, done: i, total: pending.length });
      const keys = new Set(batch.map((p) => p.key));
      const result = await this.deps.ai.json({
        route: g.settings.routes.light,
        runId: g.id,
        meter,
        signal,
        schema,
        instruction:
          "Classify each paper for a genealogy review of the research question. R: narrative review, concept or historical analysis, commentary, editorial, letter. M: systematic review, meta-analysis, umbrella review. O: original research of any design (trial, cohort, imaging, modelling, case series). P: peripheral, only indirectly related to the research question. When the metadata hint names a type, keep it unless the title and abstract clearly contradict it. Give a short Korean reason. Return every key exactly once.",
        input: JSON.stringify({
          researchQuestion: g.settings.question,
          papers: batch.map((p) => {
            const w = works.get(p.workId)!;
            return { key: p.key, title: w.title, year: w.year, venue: w.venue, hint: p.type ? `${p.type} (${p.typeReason})` : null, abstract: (w.abstract || "").slice(0, 1800) };
          }),
        }),
        parse: (value) => {
          const parsed = z.object({ papers: z.array(z.object({ key: z.string(), type: z.enum(["R", "M", "O", "P"]), reason: z.string() })) }).parse(value);
          const seen = new Set(parsed.papers.map((p) => p.key));
          if ([...keys].some((k) => !seen.has(k))) throw new Error(`missing keys: ${[...keys].filter((k) => !seen.has(k)).join(", ")}`);
          return parsed.papers.filter((p) => keys.has(p.key));
        },
      });
      const byKey = new Map(result.map((r) => [r.key, r]));
      this.deps.db.transaction(() => {
        for (const paper of batch) {
          const r = byKey.get(paper.key)!;
          const changed = paper.type !== r.type;
          Object.assign(paper, { type: r.type, typeSource: "ai", typeReason: r.reason });
          if (changed && paper.cardStatus === "done") paper.cardStatus = "stale";
          this.store.savePaper(g.id, paper);
        }
      });
      this.progress(g, { calls: meter.calls });
    }
    for (const paper of papers.filter((p) => p.typeSource === "metadata")) this.store.savePaper(g.id, paper);
  }

  private async hasPdf(workId: string) {
    for (const a of this.deps.db.attachments(workId))
      if (a.exists && existsSync(a.path))
        try {
          await verifyPdf(a.path);
          return a;
        } catch {
          // Next attachment.
        }
    return null;
  }

  /** The archive's own full-text job for papers with neither a PDF nor a PMC full text; the job waits for it. */
  private async fetchPdfs(g: Genealogy, signal: AbortSignal) {
    const need: string[] = [];
    for (const paper of this.store.papers(g.id, true)) {
      if (!(await this.hasPdf(paper.workId)) && !paper.pmcid) need.push(paper.workId);
    }
    if (!need.length) return;
    if (!(await this.deps.shelfWritable())) {
      this.progress(g, { message: "서고가 연결되지 않아 PDF를 내려받지 않았습니다." });
      return;
    }
    if (this.deps.downloads.active.size || this.deps.busy()) {
      this.progress(g, { message: "다른 원문 확보 작업이 진행 중이라 PDF 내려받기를 건너뛰었습니다." });
      return;
    }
    const sciHub = this.deps.downloads.sciHub();
    const run = this.deps.downloads.start({
      projectId: g.projectId,
      scope: "selected",
      ids: need,
      includeBooks: false,
      useBrowser: g.settings.useBrowser,
      useSciHub: sciHub.enabled,
    });
    this.progress(g, { message: `PDF 원문 확보 · ${need.length}편`, done: 0, total: need.length });
    while (true) {
      if (signal.aborted) {
        this.deps.downloads.control(run.id, "cancel");
        signal.throwIfAborted();
      }
      await Bun.sleep(1000);
      const current = this.deps.db.run(run.id);
      this.progress(g, { done: current.count, message: `PDF 원문 확보 · ${current.message}` });
      if (!["queued", "running"].includes(current.status)) break;
    }
  }

  private async paperText(work: Work, pmcid: string | null, signal: AbortSignal): Promise<PaperText | null> {
    if (pmcid) {
      const cached = this.store.text<StoredText>(`pmc:${pmcid}`);
      if (cached?.version === TEXT_VERSION) return cached;
      try {
        const xml = await europePmcXml(pmcid, signal, this.deps.fetcher);
        const text = xml ? jatsText(xml) : null;
        if (text && text.body.length > 2000) {
          this.store.text<StoredText>(`pmc:${pmcid}`, { ...text, version: TEXT_VERSION });
          return text;
        }
      } catch {
        if (signal.aborted) signal.throwIfAborted();
      }
    }
    const attachment = await this.hasPdf(work.id);
    if (!attachment) return null;
    const cached = this.store.text<StoredText>(`pdf:${attachment.hash}`);
    if (cached?.version === TEXT_VERSION) return cached;
    const result = await extractPdf(attachment.path, this.deps.workerPath, signal, "fulltext");
    if (result.status !== "extracted" || !result.text.trim()) return null;
    const text = pdfText(result.text);
    if (result.emptyPages) text.notes.push(`텍스트가 없는 ${result.emptyPages}쪽은 읽지 못했습니다.`);
    this.store.text<StoredText>(`pdf:${attachment.hash}`, { ...text, version: TEXT_VERSION });
    return text;
  }

  /** The reading text of each paper for its type; cards read exactly this. */
  async readingFor(work: Work, pmcid: string | null, type: PaperType, signal: AbortSignal) {
    return readingText(type, await this.paperText(work, pmcid, signal), work.abstract);
  }

  private async readTexts(g: Genealogy, signal: AbortSignal) {
    const papers = this.store.papers(g.id, true);
    let done = 0;
    for (const paper of papers) {
      signal.throwIfAborted();
      this.progress(g, { message: `본문 읽을 범위 정리 · ${done + 1}/${papers.length}편`, done, total: papers.length });
      const work = this.deps.db.get(paper.workId);
      let reading: Awaited<ReturnType<GenealogyEngine["readingFor"]>>;
      try {
        reading = await this.readingFor(work, paper.pmcid, paper.type ?? "O", signal);
      } catch (error) {
        if (signal.aborted) throw error;
        reading = readingText(paper.type ?? "O", null, work.abstract);
        reading.note = `본문 추출 실패: ${error instanceof Error ? error.message : "알 수 없음"} · ${reading.note}`;
      }
      const hasPdf = !!(await this.hasPdf(work.id));
      const textChanged = paper.basis !== reading.basis || paper.textSize !== reading.text.length;
      Object.assign(paper, { basis: reading.basis, textNote: reading.note, textSize: reading.text.length, hasPdf });
      if (textChanged && paper.cardStatus === "done") paper.cardStatus = "stale";
      this.store.savePaper(g.id, paper);
      done++;
    }
    this.progress(g, { done, total: papers.length });
  }

  // --- cards ---

  /** Cards for every paper without a current one, a few at a time; a spent quota stops them all. */
  private async cards(g: Genealogy, signal: AbortSignal, meter: Meter): Promise<string | void> {
    const papers = this.store.papers(g.id, true).filter((p) => p.cardStatus !== "done");
    const total = papers.length;
    let done = 0;
    const queue = [...papers];
    const stop = new AbortController();
    const linked = AbortSignal.any([signal, stop.signal]);
    let halt: unknown = null;
    this.progress(g, { message: total ? `문헌 카드 · 0/${total}편` : "만들 카드가 없습니다.", done: 0, total });
    const worker = async () => {
      while (queue.length && !halt) {
        const paper = queue.shift()!;
        try {
          await this.card(g, paper, linked, meter);
        } catch (error) {
          if (signal.aborted) throw error;
          if (halt) return;
          if (error instanceof AppError && error.code === "BUDGET") {
            halt = error;
            stop.abort();
            return;
          }
          this.store.savePaper(g.id, { ...paper, cardStatus: "failed", cardError: error instanceof Error ? error.message : "카드를 만들지 못했습니다." });
        }
        done++;
        this.progress(g, { done, total, calls: meter.calls, message: `문헌 카드 · ${done}/${total}편 · ${paper.key}` });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(g.settings.concurrency, total)) }, worker));
    signal.throwIfAborted();
    if (halt) throw halt;
    await this.writeCards(g);
    const failed = this.store.papers(g.id, true).filter((p) => p.cardStatus === "failed").length;
    if (failed) return `카드 ${failed}편을 만들지 못했습니다. 문헌 탭에서 이유를 확인하고 다시 실행하세요.`;
  }

  /** Longest reading text one card call reads; longer reviews are read in parts and merged. */
  static PART = 150_000;

  private async card(g: Genealogy, paper: GenealogyPaper, signal: AbortSignal, meter: Meter) {
    const work = this.deps.db.get(paper.workId);
    const type = paper.type ?? "O";
    const reading = await this.readingFor(work, paper.pmcid, type, signal);
    if (reading.basis === "none") throw new AppError("NO_TEXT", "읽을 본문과 초록이 없습니다. PDF를 연결하거나 초록을 채운 뒤 다시 실행하세요.");
    const current = { ...paper, type, basis: reading.basis, textNote: reading.note, textSize: reading.text.length };
    const parts = splitText(reading.text, GenealogyEngine.PART);
    const read = (text: string, strict: boolean, instruction = cardInstruction(type, g.settings), input = cardInput(current, work, g.settings, text)) =>
      this.deps.ai.json({
        route: g.settings.routes.cards,
        runId: g.id,
        meter,
        signal,
        schema: CARD_SCHEMA,
        instruction,
        input,
        parse: (value) => parseCard(value, text, paper.key, type, strict),
      });
    let card: GenealogyCard;
    if (parts.length === 1) card = await read(reading.text, true);
    else {
      const partial: GenealogyCard[] = [];
      for (const [i, part] of parts.entries()) partial.push(await read(part, true, `${cardInstruction(type, g.settings)}\n\nThis is part ${i + 1} of ${parts.length} of the paper's text.`));
      card = await read(reading.text, false, MERGE_INSTRUCTION, JSON.stringify({ paper: JSON.parse(cardInput(current, work, g.settings, "")).paper, partialCards: partial }));
    }
    this.store.saveCard(g.id, paper.workId, card);
    this.store.savePaper(g.id, { ...current, cardStatus: "done", cardError: "" });
  }

  /** Writes cards/NNN_citekey.md in publication order and removes card files of papers no longer in the report. */
  async writeCards(g: Genealogy) {
    const dir = join(g.workspace, "cards");
    await mkdir(dir, { recursive: true });
    const cards = this.store.cards(g.id);
    const papers = this.store.papers(g.id, true).filter((p) => cards.has(p.workId));
    const names = new Set<string>();
    for (const [i, paper] of papers.entries()) {
      const name = `${String(i + 1).padStart(3, "0")}_${paper.key.replace(/[^\p{L}\p{N}_.-]/gu, "")}.md`;
      names.add(name);
      await writeFile(join(dir, name), cardMarkdown(cards.get(paper.workId)!, paper, this.deps.db.get(paper.workId)));
    }
    for (const file of await readdir(dir))
      if (/^\d{3}_.+\.md$/.test(file) && !names.has(file)) await rm(join(dir, file), { force: true });
  }
}

