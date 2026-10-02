import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Library } from "../db/database";
import { extractPdf, hashFile, verifyPdf, hasValidPdf } from "../interchange/pdf";
import { cleanDoi, FulltextEngine, isBook } from "./engine";
import { ChromeDownloads, chromeDownloadDirectories, type BrowserRetrieval } from "./chrome";
import { LocalDownloads, isAuxiliaryPdf } from "./local-downloads";
import type { RetrievedPdf } from "./engine";
import { titleSimilarity } from "../../shared/domain";
import { AppError, DEFAULT_FILTERS, now, type AppEvent, type MissingPdfs, type PdfDownloadItem, type PdfDownloadPreview, type PdfDownloadScope, type Run, type Work } from "../../shared/types";

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
  private local: LocalDownloads;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private historySync?: Promise<void>;
  constructor(
    private db: Library,
    private workerPath: string,
    private emit: (event: AppEvent) => void,
    private engine = new FulltextEngine(),
    private browser: BrowserRetrieval = new ChromeDownloads(),
  ) { this.local = new LocalDownloads(workerPath); }
  rememberDirectory(directory: string) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) throw new AppError('CHROME_DIRECTORY', '다운로드 폴더의 절대 경로가 필요합니다.');
    this.db.pref('pdfDownloadDirectory', directory);
  }
  startRecoveryMonitor(blocked: () => boolean, intervalMs = 5000) {
    if (this.recoveryTimer) return;
    this.stopping = false;
    this.recoveryTimer = setInterval(() => {
      if (!this.stopping && !blocked()) void this.recoverCompleted().catch(() => {});
    }, intervalMs);
    this.recoveryTimer.unref();
  }
  stopRecoveryMonitor() { this.stopping = true; clearInterval(this.recoveryTimer); this.recoveryTimer = undefined; }
  private async directories(run: Run) {
    const directory = run.download!.downloadDirectory || this.db.pref<string>('pdfDownloadDirectory');
    const directories = directory ? [directory] : await chromeDownloadDirectories();
    run.download!.observedDirectories = directories;
    if (directory) run.download!.downloadDirectory = directory;
    return directories;
  }
  private async validate(work: Work, path: string, signal: AbortSignal, candidate: RetrievedPdf) {
    await verifyPdf(path);
    const inspected = await extractPdf(path, this.workerPath, signal);
    if (!inspected.pages) throw new AppError('INVALID_PDF', 'PDF가 손상·암호화되어 있거나 내용을 검증할 수 없습니다.');
    if (isAuxiliaryPdf(inspected)) throw new AppError('AUXILIARY_PDF', '보충자료·정오표 PDF입니다. 본문 원문으로 첨부하지 않았습니다.');
    const expectedDoi = candidate.doi || cleanDoi(work.doi);
    const detected = inspected.dois.map(cleanDoi).filter(Boolean);
    if (candidate.requireIdentity && !(expectedDoi && detected.includes(expectedDoi)) && titleSimilarity(work.title, inspected.title) < 0.7)
      throw new AppError('WRONG_PDF', '새 다운로드의 DOI·제목이 대상 문헌과 일치하지 않아 첨부하지 않았습니다.');
    if (expectedDoi && detected.length === 1 && detected[0] !== expectedDoi && titleSimilarity(work.title, inspected.title) < 0.5)
      throw new AppError('WRONG_PDF', 'PDF의 DOI·제목이 대상 논문과 다릅니다. 직접 확인 후 연결하세요.');
  }
  private async attach(run: Run, item: PdfDownloadItem, work: Work, path: string, signal: AbortSignal, retrieved: RetrievedPdf, downloadedPath?: string) {
    const hash = await hashFile(path, signal);
    const size = (await stat(path)).size;
    const destination = join(this.db.root, 'attachments', hash + '.pdf');
    signal.throwIfAborted();
    if (await hashFile(destination, signal).catch(() => null) !== hash) {
      signal.throwIfAborted(); await rename(path, destination);
    }
    signal.throwIfAborted();
    if (!this.isArchived(run.projectId, work.id)) { item.status = 'skipped'; item.message = '확보 중 아카이브에서 제거됨'; return; }
    this.db.transaction(() => {
      const attachment = this.db.attachments(work.id).find(a => a.hash === hash);
      this.db.saveAttachment({id:attachment?.id || randomUUID(), workId:work.id, name:work.title + '.pdf', path:destination,
        hash, mode:'managed', size, status:downloadedPath ? '다운로드 파일 복구 · PDF 검증됨' : '원문 확보 · PDF 검증됨', exists:true,
        sourceUrl:retrieved.sourceUrl, retrievalMethod:retrieved.method, fetchedAt:now(), version:retrieved.version});
      item.status = 'completed'; item.message = downloadedPath ? '다운로드 파일 자동 복구·검증·첨부 완료' : `${retrieved.method === 'chrome' ? 'Chrome에서 ' : ''}PDF 확보·검증·첨부 완료`;
      item.sourceUrl = retrieved.sourceUrl; item.retrievalMethod = retrieved.method;
      if (downloadedPath) item.downloadedPath = downloadedPath;
      delete item.errorCode;
      this.save(run, 'changed');
    });
    await this.syncHistory();
  }
  private async reconcile(run: Run, staging: string, signal: AbortSignal) {
    if (!run.download!.useBrowser) return 0;
    const targets = run.download!.items.filter(item => this.isArchived(run.projectId, item.workId)).map(item => this.db.get(item.workId));
    const needed = run.download!.items.filter(item => ['pending', 'failed'].includes(item.status) && targets.some(w => w.id === item.workId));
    if (!needed.length) return 0;
    let recovered = 0;
    const directories = await this.directories(run);
    await this.local.scan(directories, signal);
    for (const item of needed) {
      signal.throwIfAborted();
      const work = this.db.get(item.workId);
      if (!run.download!.includeBooks && isBook(work)) continue;
      if (await this.existing(work.id, signal)) continue;
      const path = join(staging, randomUUID() + '.part');
      try {
        const downloadedPath = await this.local.copyFor(work, targets, path, signal);
        if (!downloadedPath) continue;
        const candidate = {sourceUrl:work.url || (work.doi ? `https://doi.org/${work.doi}` : ''), doi:cleanDoi(work.doi), requireIdentity:true, method:'chrome' as const};
        await this.validate(work, path, signal, candidate);
        await this.attach(run, item, work, path, signal, candidate, downloadedPath);
        if (item.status === 'completed') recovered++;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof AppError && item.message !== error.message) {
          item.errorCode = error.code; item.message = error.message; this.save(run, 'progress');
        }
      }
      finally { await rm(path, {force:true}); }
    }
    return recovered;
  }
  async recoverCompleted() {
    if (this.active.size || this.stopping) return;
    await this.syncHistory();
    for (const run of this.db.runs()) {
      if (!run.download?.useBrowser) continue;
      if (!['completed', 'failed'].includes(run.status) || !run.download.items.some(i => i.status === 'failed' || i.status === 'pending')) continue;
      const control = new AbortController();
      this.active.set(run.id, control);
      const staging = join(this.db.root, 'downloads', run.id);
      try {
        await mkdir(staging, {recursive:true});
        const recovered = await this.reconcile(run, staging, AbortSignal.any([control.signal, AbortSignal.timeout(30000)]));
        if (recovered) { this.summarize(run); this.save(run, 'changed'); }
      } finally { await rm(staging, {recursive:true, force:true}); this.active.delete(run.id); }
      if (this.stopping) return;
    }
  }
  async syncHistory() {
    if (this.stopping) return;
    if (this.historySync) return this.historySync;
    this.historySync = this.updateHistory();
    try { await this.historySync; } finally { this.historySync = undefined; }
  }
  private async updateHistory() {
    // Read every download run, including older runs outside the UI's 100-run window.
    const runs = (this.db.db.prepare("SELECT data FROM runs WHERE json_type(data,'$.download')='object'")
      .all() as { data: string }[]).map(row => JSON.parse(row.data) as Run);
    const verified = new Map<string, boolean>();
    for (const previous of runs) {
      if (this.stopping) return;
      if (this.active.has(previous.id)) continue;
      const unresolved = previous.download!.items.filter(item => !["completed", "existing"].includes(item.status));
      for (const item of unresolved) {
        if (!verified.has(item.workId)) verified.set(item.workId, await this.existing(item.workId));
        if (this.stopping) return;
      }
      // A new run/resume may have started while the files were being checked.
      if (this.active.has(previous.id)) continue;
      const run = this.db.run(previous.id);
      let changed = false;
      for (const item of run.download!.items) {
        if (["completed", "existing"].includes(item.status) || !verified.get(item.workId)) continue;
        item.status = "completed";
        item.message = "연결된 보관 PDF 검증됨";
        delete item.errorCode;
        changed = true;
      }
      if (changed) {
        this.summarize(run);
        this.save(run, "changed");
      }
    }
  }
  private summarize(run: Run) {
    const items = run.download!.items, failed = items.filter(i => i.status === 'failed').length;
    run.message = `${run.status === 'cancelled' ? '중단 · ' : ''}새 PDF ${items.filter(i => i.status === 'completed').length}편 · 기존 ${items.filter(i => i.status === 'existing').length}편 · 제외 ${items.filter(i => i.status === 'skipped').length}편 · 실패 ${failed}편${run.status !== 'completed' ? ' · 재개 가능' : failed ? ' · 실패 항목 재시도 가능' : ''}`;
  }
  private targets(target: DownloadTarget, limited = true): Work[] {
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
    if (limited && works.length > 1000) throw new AppError("DOWNLOAD_LIMIT", "한 번에 1,000편 이하를 선택하세요.");
    return works;
  }
  private async existing(workId: string, signal?: AbortSignal) {
    return hasValidPdf(this.db, workId, signal);
  }
  async missing(target: DownloadTarget): Promise<MissingPdfs> {
    const works = this.targets(target, false);
    const items: MissingPdfs["items"] = [];
    let existing = 0, books = 0;
    for (const work of works) {
      if (await this.existing(work.id)) existing++;
      else if (!target.includeBooks && isBook(work)) books++;
      else items.push({ workId: work.id, title: work.title, status: "untried", message: "아직 원문 확보를 시도하지 않았습니다." });
    }
    // Attachment verification is authoritative. History only supplies an explanation,
    // including runs older than the snapshot's 100-run window.
    const runs = (this.db.db.prepare("SELECT data FROM runs WHERE project_id=? AND json_type(data,'$.download')='object' ORDER BY json_extract(data,'$.createdAt') DESC, rowid DESC")
      .all(target.projectId) as { data: string }[]).map(row => JSON.parse(row.data) as Run);
    const latest = new Map<string, PdfDownloadItem>();
    for (const run of [...runs.filter(r => this.active.has(r.id)), ...runs.filter(r => !this.active.has(r.id))]) {
      for (const item of run.download!.items) if (!latest.has(item.workId)) latest.set(item.workId, item);
    }
    for (const item of items) {
      const attempt = latest.get(item.workId);
      if (!attempt) continue;
      if (attempt.status === "completed" || attempt.status === "existing") {
        item.status = "missing";
        item.message = "이전에 연결한 PDF를 찾거나 검증할 수 없습니다. 다시 연결하세요.";
      } else {
        item.status = attempt.status;
        item.message = attempt.message;
      }
    }
    items.sort((a, b) => a.title.localeCompare(b.title, "ko") || a.workId.localeCompare(b.workId));
    const directory = this.db.pref<string>("pdfDownloadDirectory");
    return { total: works.length, existing, books, eligible: items.length, items, ...(directory ? { downloadDirectory: directory } : {}) };
  }
  async preview(target: DownloadTarget): Promise<PdfDownloadPreview> {
    const works = this.targets(target);
    let existing = 0, books = 0;
    for (const work of works) {
      if (await this.existing(work.id)) existing++;
      else if (!target.includeBooks && isBook(work)) books++;
    }
    const directory = this.db.pref<string>('pdfDownloadDirectory');
    return { total: works.length, existing, books, eligible: works.length - existing - books, ...(directory ? {downloadDirectory:directory} : {}) };
  }
  start(target: DownloadTarget) {
    if (this.active.size) throw new AppError("BUSY", "원문 확보 작업이 진행 중입니다.");
    const works = this.targets(target);
    if (!works.length) throw new AppError("DOWNLOAD_EMPTY", "대상 아카이브에 문헌이 없습니다.");
    if (target.downloadDirectory) this.rememberDirectory(target.downloadDirectory);
    target = {...target, downloadDirectory:target.downloadDirectory || this.db.pref<string>('pdfDownloadDirectory')};
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
    if (downloadDirectory !== undefined) { this.rememberDirectory(downloadDirectory); run.download.downloadDirectory = downloadDirectory; }
    else run.download.downloadDirectory ||= this.db.pref<string>('pdfDownloadDirectory');
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
      await this.reconcile(run, staging, signal).catch(() => { signal.throwIfAborted(); });
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
          const validate = (candidate: RetrievedPdf) => this.validate(work, path, itemSignal, candidate);
          let retrieved: RetrievedPdf | undefined;
          let chromeFailure = browserError;
          if (run.download!.useBrowser && !browserError) {
            try { retrieved = await this.browser.retrieve(work, path, itemSignal, progress, validate, run.download!.downloadDirectory); }
            catch (error) {
              itemSignal.throwIfAborted();
              chromeFailure = error instanceof AppError ? error : new AppError("CHROME_TIMEOUT", "Chrome 원문 확보 시간이 초과되었습니다.");
              // Only settings that affect every paper disable Chrome for the run.
              // A closed tab, slow page or command failure must not poison later items.
              if (["CHROME_PERMISSION", "CHROME_JAVASCRIPT", "CHROME_DIRECTORY"].includes(chromeFailure.code)) {
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
          await this.attach(run, item, work, path, itemSignal, retrieved);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof AppError) item.errorCode = error.code;
          item.status = itemControl.signal.aborted ? "skipped" : "failed";
          item.message = itemControl.signal.aborted ? "사용자가 이 문헌을 건너뛰었습니다." : error instanceof AppError ? error.message : (error as Error)?.name === "TimeoutError"
            ? "논문당 조회 시간이 초과되었습니다. 재시도하거나 원문을 직접 연결하세요."
            : "원문 서버 연결 또는 PDF 저장·검증에 실패했습니다. 재시도하거나 직접 연결하세요.";
        } finally {
          this.currentItems.delete(id);
          await rm(path, { force: true });
          this.save(run, "progress");
          await this.reconcile(run, staging, signal).catch(() => { signal.throwIfAborted(); });
        }
      }
      run.status = "completed";
    } catch {
      run.status = signal.aborted ? "cancelled" : "failed";
      if (current?.status === "running") { current.status = "pending"; current.message = "중단됨 · 재개 가능"; }
    } finally {
      await rm(join(this.db.root, "downloads", id), { recursive: true, force: true }).catch(() => {});
      this.summarize(run);
      this.save(run, "changed");
      this.active.delete(id);
    }
  }
}
