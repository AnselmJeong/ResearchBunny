import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Library } from "../db/database";
import { extractPdf, hashFile, verifyPdf } from "../interchange/pdf";
import { cleanDoi, FulltextEngine, isBook } from "./engine";
import { ChromeDownloads, type BrowserRetrieval } from "./chrome";
import type { RetrievedPdf } from "./engine";
import { titleSimilarity } from "../../shared/domain";
import { AppError, DEFAULT_FILTERS, now, type AppEvent, type PdfDownloadItem, type PdfDownloadPreview, type PdfDownloadScope, type Run, type Work } from "../../shared/types";

export interface DownloadTarget {
  projectId: string;
  scope: PdfDownloadScope;
  ids?: string[];
  scopeId?: string;
  includeBooks?: boolean;
  useBrowser?: boolean;
  downloadDirectory?: string;
}
export class PdfDownloads {
  active = new Map<string, AbortController>();
  private currentItems = new Map<string, AbortController>();
  constructor(
    private db: Library,
    private workerPath: string,
    private emit: (event: AppEvent) => void,
    private engine = new FulltextEngine(),
    private browser: BrowserRetrieval = new ChromeDownloads(),
  ) {}
  private targets(target: DownloadTarget): Work[] {
    this.db.project(target.projectId);
    let works = (this.db.db.prepare("SELECT w.data FROM works w JOIN project_works pw ON pw.work_id=w.id WHERE pw.project_id=? AND json_extract(pw.state,'$.screening')='included' ORDER BY w.id")
      .all(target.projectId) as { data: string }[]).map(r => this.db.get((JSON.parse(r.data) as Work).id));
    if (target.scope === "selected") {
      const ids = new Set(target.ids || []);
      if (!ids.size || [...ids].some(id => !works.some(w => w.id === id)))
        throw new AppError("DOWNLOAD_TARGET", "이 프로젝트의 아카이브에 저장된 문헌을 선택하세요.");
      works = works.filter(w => ids.has(w.id));
    } else if (target.scope === "topic" || target.scope === "unclassified") {
      if (target.scope === "topic" && !this.db.db.prepare("SELECT id FROM archive_topics WHERE id=? AND project_id=?").get(target.scopeId || "", target.projectId))
        throw new AppError("DOWNLOAD_TARGET", "이 프로젝트의 분류를 선택하세요.");
      const memberships = new Map((this.db.db.prepare("SELECT work_id,topic_id FROM archive_topic_works WHERE project_id=?")
        .all(target.projectId) as { work_id: string; topic_id: string }[]).map(r => [r.work_id, r.topic_id]));
      works = works.filter(w => target.scope === "unclassified" ? !memberships.has(w.id) : memberships.get(w.id) === target.scopeId);
    } else if (target.scope === "collection") {
      if (!this.db.collections(target.projectId).some(c => c.id === target.scopeId))
        throw new AppError("DOWNLOAD_TARGET", "이 프로젝트의 컬렉션을 선택하세요.");
      const members = new Set((this.db.db.prepare("SELECT work_id FROM collection_works WHERE collection_id=?").all(target.scopeId!) as { work_id: string }[]).map(r => r.work_id));
      works = works.filter(w => members.has(w.id));
    } else if (target.scope !== "archive") throw new AppError("DOWNLOAD_TARGET", "원문 확보 범위를 확인하세요.");
    if (works.length > 1000) throw new AppError("DOWNLOAD_LIMIT", "한 번에 1,000편 이하를 선택하세요.");
    return works;
  }
  private async existing(workId: string, signal?: AbortSignal) {
    for (const attachment of this.db.attachments(workId)) {
      try {
        await verifyPdf(attachment.path);
        if (await hashFile(attachment.path, signal) === attachment.hash) return true;
      } catch { signal?.throwIfAborted(); }
    }
    return false;
  }
  async preview(target: DownloadTarget): Promise<PdfDownloadPreview> {
    const works = this.targets(target);
    let existing = 0, books = 0;
    for (const work of works) {
      if (await this.existing(work.id)) existing++;
      else if (!target.includeBooks && isBook(work)) books++;
    }
    return { total: works.length, existing, books, eligible: works.length - existing - books };
  }
  start(target: DownloadTarget) {
    if (this.active.size) throw new AppError("BUSY", "원문 확보 작업이 진행 중입니다.");
    const works = this.targets(target);
    if (!works.length) throw new AppError("DOWNLOAD_EMPTY", "대상 아카이브에 문헌이 없습니다.");
    const run: Run = {
      id: randomUUID(), projectId: target.projectId, mode: "search", query: `PDF 원문 확보 (${works.length}편)`,
      seedProfileId: null, inputIds: works.map(w => w.id), filters: { ...DEFAULT_FILTERS },
      status: "queued", createdAt: now(), updatedAt: now(), calls: 0, maxCalls: 0,
      maxCandidates: works.length, total: works.length, count: 0, message: "원문 확보 준비",
      tasks: [], rankingVersion: "fulltext-v1",
      download: { includeBooks: !!target.includeBooks, useBrowser: !!target.useBrowser, downloadDirectory: target.downloadDirectory, items: works.map(w => ({ workId: w.id, title: w.title, status: "pending", message: "대기 중" })) },
    };
    this.db.saveRun(run);
    void this.execute(run.id);
    return run;
  }
  control(id: string, action: string, useBrowser?: boolean, downloadDirectory?: string) {
    if (action === "cancel") { this.active.get(id)?.abort(); return; }
    if (action === "skip") { this.currentItems.get(id)?.abort(new AppError("DOWNLOAD_SKIPPED", "사용자가 이 문헌을 건너뛰었습니다.")); return; }
    if (action !== "resume") throw new AppError("INVALID", "원문 확보는 재시도로 이어갈 수 있습니다.");
    if (this.active.size) throw new AppError("BUSY", "원문 확보 작업이 진행 중입니다.");
    const run = this.db.run(id);
    if (!run.download) throw new AppError("INVALID", "원문 확보 작업이 아닙니다.");
    if (useBrowser !== undefined) run.download.useBrowser = useBrowser;
    if (downloadDirectory !== undefined) run.download.downloadDirectory = downloadDirectory;
    for (const item of run.download.items) {
      if (["pending", "running", "failed"].includes(item.status)) {
        item.status = "pending"; item.message = "재시도 대기";
      }
    }
    run.status = "queued";
    this.db.saveRun(run);
    void this.execute(id);
  }
  private save(run: Run, type: AppEvent["type"] = "progress") {
    run.count = run.download!.items.filter(i => i.status === "completed" || i.status === "existing").length;
    run.updatedAt = now();
    this.db.saveRun(run);
    this.emit({ type, runId: run.id });
  }
  private isArchived(projectId: string, workId: string) {
    return this.db.state(projectId, workId).screening === "included" &&
      !!this.db.db.prepare("SELECT 1 FROM project_works WHERE project_id=? AND work_id=?").get(projectId, workId);
  }
  async execute(id: string) {
    const control = new AbortController();
    this.active.set(id, control);
    const signal = control.signal;
    const run = this.db.run(id);
    let current: PdfDownloadItem | undefined;
    let browserError: AppError | undefined;
    run.status = "running";
    this.save(run);
    try {
      const staging = join(this.db.root, "downloads", id);
      await mkdir(staging, { recursive: true });
      for (const [index, item] of run.download!.items.entries()) {
        signal.throwIfAborted();
        if (item.status !== "pending") continue;
        current = item;
        const itemControl = new AbortController();
        this.currentItems.set(id, itemControl);
        const itemSignal = AbortSignal.any([signal, itemControl.signal]);
        const path = join(staging, randomUUID() + ".part");
        try {
          if (!this.isArchived(run.projectId, item.workId)) {
            item.status = "skipped"; item.message = "아카이브에서 제거된 문헌"; continue;
          }
          const work = this.db.get(item.workId);
          if (await this.existing(work.id, itemSignal)) { item.status = "existing"; item.message = "검증한 보관 PDF 있음"; continue; }
          if (!run.download!.includeBooks && isBook(work)) { item.status = "skipped"; item.message = "책·챕터 기본 제외"; continue; }
          item.status = "running";
          run.message = `원문 ${index + 1}/${run.total} · ${item.title}`;
          this.save(run);
          const progress = (message: string) => {
            item.message = message;
            run.message = `${index + 1}/${run.total} · ${message} · ${item.title}`;
            this.save(run);
          };
          const validate = async (candidate: RetrievedPdf) => {
            await verifyPdf(path);
            const inspected = await extractPdf(path, this.workerPath, itemSignal);
            if (!inspected.pages) throw new AppError("INVALID_PDF", "PDF가 손상·암호화되어 있거나 내용을 검증할 수 없습니다.");
            const expectedDoi = candidate.doi || cleanDoi(work.doi);
            const detected = inspected.dois.map(cleanDoi).filter(Boolean);
            if (candidate.requireIdentity && !(expectedDoi && detected.includes(expectedDoi)) && titleSimilarity(work.title, inspected.title) < 0.7)
              throw new AppError("WRONG_PDF", "새 다운로드의 DOI·제목이 대상 문헌과 일치하지 않아 첨부하지 않았습니다.");
            if (expectedDoi && detected.length === 1 && detected[0] !== expectedDoi && titleSimilarity(work.title, inspected.title) < 0.5)
              throw new AppError("WRONG_PDF", "PDF의 DOI·제목이 대상 논문과 다릅니다. 직접 확인 후 연결하세요.");
          };
          let retrieved: RetrievedPdf | undefined;
          let chromeFailure = browserError;
          if (run.download!.useBrowser && !browserError) {
            try { retrieved = await this.browser.retrieve(work, path, itemSignal, progress, validate, run.download!.downloadDirectory); }
            catch (error) {
              itemSignal.throwIfAborted();
              chromeFailure = error instanceof AppError ? error : new AppError("CHROME_TIMEOUT", "Chrome 원문 확보 시간이 초과되었습니다.");
              if (["CHROME_PERMISSION", "CHROME_JAVASCRIPT", "CHROME_CONTROL", "CHROME_DIRECTORY"].includes(chromeFailure.code)) {
                browserError = chromeFailure;
                this.emit({type:"service-error", message:chromeFailure.message});
              }
              progress("공개 원문 보조 경로 확인");
            }
          }
          if (!retrieved) {
            try { retrieved = await this.engine.retrieve(work, path, itemSignal, progress, validate); }
            catch (error) { if (chromeFailure) throw chromeFailure; throw error; }
          }
          const hash = await hashFile(path, itemSignal);
          const size = (await stat(path)).size;
          const destination = join(this.db.root, "attachments", hash + ".pdf");
          itemSignal.throwIfAborted();
          // Repair a missing/corrupt managed copy; never overwrite a linked source file.
          if (await hashFile(destination, itemSignal).catch(() => null) !== hash) {
            itemSignal.throwIfAborted();
            await rename(path, destination);
          }
          itemSignal.throwIfAborted();
          if (!this.isArchived(run.projectId, work.id)) { item.status = "skipped"; item.message = "확보 중 아카이브에서 제거됨"; continue; }
          this.db.transaction(() => {
            const attachment = this.db.attachments(work.id).find(a => a.hash === hash);
            this.db.saveAttachment({
              id: attachment?.id || randomUUID(), workId: work.id, name: work.title + ".pdf",
              path: destination, hash, mode: "managed", size, status: "원문 확보 · PDF 검증됨", exists: true,
              sourceUrl: retrieved.sourceUrl, retrievalMethod:retrieved.method, fetchedAt: now(), version: retrieved.version,
            });
            item.status = "completed"; item.message = `${retrieved.method === "chrome" ? "Chrome에서 " : ""}PDF 확보·검증·첨부 완료`; item.sourceUrl = retrieved.sourceUrl; item.retrievalMethod = retrieved.method;
            this.save(run, "changed");
          });
        } catch (error) {
          signal.throwIfAborted();
          item.status = itemControl.signal.aborted ? "skipped" : "failed";
          item.message = itemControl.signal.aborted ? "사용자가 이 문헌을 건너뛰었습니다." : error instanceof AppError ? error.message : (error as Error)?.name === "TimeoutError"
            ? "논문당 조회 시간이 초과되었습니다. 재시도하거나 원문을 직접 연결하세요."
            : "원문 서버 연결 또는 PDF 저장·검증에 실패했습니다. 재시도하거나 직접 연결하세요.";
        } finally {
          this.currentItems.delete(id);
          await rm(path, { force: true });
          this.save(run, "progress");
        }
      }
      run.status = "completed";
    } catch {
      run.status = signal.aborted ? "cancelled" : "failed";
      if (current?.status === "running") { current.status = "pending"; current.message = "중단됨 · 재개 가능"; }
    } finally {
      await rm(join(this.db.root, "downloads", id), { recursive: true, force: true }).catch(() => {});
      const items = run.download!.items;
      const failed = items.filter(i => i.status === "failed").length;
      run.message = `${run.status === "cancelled" ? "중단 · " : ""}새 PDF ${items.filter(i => i.status === "completed").length}편 · 기존 ${items.filter(i => i.status === "existing").length}편 · 제외 ${items.filter(i => i.status === "skipped").length}편 · 실패 ${failed}편${run.status !== "completed" ? " · 재개 가능" : failed ? " · 실패 항목 재시도 가능" : ""}`;
      this.save(run, "changed");
      this.active.delete(id);
    }
  }
}
