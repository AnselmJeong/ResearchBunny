import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Library } from "../db/database";
import type { OpenAlex } from "../providers/openalex";
import { OllamaLocal } from "../providers/ollama-local";
import type { FetchLike } from "../search/web-search";
import { extractPdf, hashFile } from "../interchange/pdf";
import { isAuxiliaryPdf } from "../interchange/pdf-identity";
import { ShelfResolver, slimRaw, type Resolution } from "./resolver";
import { diskSpelling, folderId, movedRel, parentRel, planScan, rootOnline, rootRelation, walk, type Walked } from "./scanner";
import { VectorIndex } from "./vectors";
import { AppError, now, type AppEvent, type Attachment, type Work } from "../../shared/types";
import { blankWork, normalizeDoi } from "../../shared/domain";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_SHELF_EXCLUDE,
  EMBED_PROMPTS,
  extractAbstractCandidate,
  formatShelfFilename,
  isInboxFolder,
  isUncategorizedFolder,
  pageLead,
  parseShelfFilename,
  SHELF_UNCATEGORIZED,
  type EmbedBasis,
  type ShelfAdoptResult,
  type ShelfConfig,
  type ShelfFileInfo,
  type ShelfIndexCounts,
  type ShelfJob,
  type ShelfMoveMode,
  type ShelfMovePreview,
  type ShelfStage,
  type ShelfStatus,
  type ShelfStatusResult,
  type ShelfSummary,
} from "../../shared/shelf";

export interface FileRow {
  id: string;
  root_id: string;
  folder_id: string;
  rel_path: string;
  size: number;
  mtime: number;
  hash: string | null;
  hashed_size: number | null;
  hashed_mtime: number | null;
  work_id: string | null;
  attachment_id: string | null;
  stage: ShelfStage;
  status: ShelfStatus;
  info: string;
  seen_at: string;
  missing_since: string | null;
}
export interface RootRow {
  id: string;
  path: string;
  name: string;
  exclude: string;
  created_at: string;
  last_scan_at: string | null;
}
const CHUNK = 48;
const RESCAN_MS = 30 * 60 * 1000;
const OFFLINE_RETRY_MS = 2 * 60 * 1000;
/** Hidden while being written: neither the scanner nor intake.py picks up dot files. */
const TEMP_PREFIX = ".researchbunny-";
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
interface RootMove {
  mode: ShelfMoveMode;
  /** Every stored file id with its relative path under the new root, or null when it leaves the index. */
  rels: Map<string, string | null>;
}
const MOVE_MESSAGES: Record<ShelfMoveMode, string> = {
  first: "",
  same: "",
  remount: "서고 위치를 바꿨습니다 · 같은 파일을 새 위치에서 찾아 색인을 그대로 옮겼습니다.",
  parent: "서고 위치를 상위 폴더로 넓혔습니다 · 기존 색인은 그대로 두고 새 폴더를 색인합니다.",
  subfolder: "서고 위치를 하위 폴더로 좁혔습니다 · 폴더 밖의 파일은 색인에서 뺐습니다.",
  new: "서고 위치를 새 폴더로 바꿨습니다 · 처음부터 색인합니다.",
};
function shelfPath(input: string) {
  const path = resolve(input.trim());
  if (!isAbsolute(path) || path === "/") throw new AppError("SHELF_PATH", "서고 폴더의 절대 경로를 선택하세요.");
  return path;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const parseInfo = (row: Pick<FileRow, "info">): ShelfFileInfo => JSON.parse(row.info || "{}");
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}
/** Text that represents a paper for embedding, in order of preference. */
export function embedInput(work: Work, info: ShelfFileInfo | null): { basis: EmbedBasis; title: string; text: string } {
  if (work.abstract?.trim())
    return { basis: work.raw?.abstractSource === "pdf" ? "pdf-abstract" : "abstract", title: work.title, text: work.abstract.trim() };
  if (info?.page1?.trim()) return { basis: "page1", title: work.title, text: info.page1.trim() };
  return { basis: "title", title: work.title, text: "" };
}
/** First free "name.pdf", "name (2).pdf", … in a folder, numbered the way intake.py numbers clashes. */
async function freeName(dir: string, name: string) {
  const stem = name.replace(/\.pdf$/i, "");
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n}).pdf`;
    if (!(await lstat(join(dir, candidate)).catch(() => null))) return candidate;
  }
}

export class Shelf {
  readonly vectors: VectorIndex;
  readonly ollama: OllamaLocal;
  private resolver: ShelfResolver;
  private control: AbortController | null = null;
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private followUp?: ReturnType<typeof setTimeout>;
  private confirmMissing = false;
  private held = false;
  private resolverPausedUntil = 0;
  private resolverReason = "";
  private resolverCode = "";
  private embeddingPaused = "";
  private modelKey: string | null = null;
  private managed: Map<string, string> | null = null;
  private lastProgress = 0;
  private lastChanged = 0;
  online = true;
  /** Bumped on every committed index change; search helpers rebuild caches lazily. */
  revision = 0;
  job: ShelfJob = { state: "idle", message: "", updatedAt: now() };

  constructor(
    private db: Library,
    private oa: OpenAlex,
    private workerPath: string,
    private emit: (event: AppEvent) => void,
    private keys: () => { pubmed?: string },
    fetcher: FetchLike = fetch,
  ) {
    this.vectors = new VectorIndex(db);
    this.ollama = new OllamaLocal(() => this.config()?.ollamaUrl || DEFAULT_OLLAMA_URL, fetcher);
    this.resolver = new ShelfResolver(oa, () => this.keys().pubmed, fetcher);
    this.modelKey = db.pref<string>("shelf:modelKey") || null;
    // A pause survives restarts: reopening the app must not spend a request that will be refused again.
    const pause = db.pref<{ until: number; code: string; reason: string } | null>("shelf:resolverPause");
    if (pause && pause.until > Date.now()) {
      this.resolverPausedUntil = pause.until;
      this.resolverCode = pause.code;
      this.resolverReason = pause.reason;
      this.job = { state: "idle", message: `서지 확인 대기 · ${pause.reason}`, resolverPausedUntil: new Date(pause.until).toISOString(), updatedAt: now() };
    }
  }
  private pauseResolver(code: string, until: number, reason: string) {
    this.resolverPausedUntil = until;
    this.resolverCode = code;
    this.resolverReason = reason;
    this.db.pref("shelf:resolverPause", { until, code, reason, at: now() });
  }
  private clearResolverPause() {
    this.resolverPausedUntil = 0;
    this.resolverCode = "";
    this.resolverReason = "";
    this.db.db.prepare("DELETE FROM preferences WHERE key='shelf:resolverPause'").run();
  }

  get active() {
    return !!this.control;
  }
  config(): ShelfConfig | null {
    return this.db.pref<ShelfConfig>("shelf") || null;
  }
  root(): RootRow | null {
    return (this.db.db.prepare("SELECT * FROM shelf_roots ORDER BY created_at LIMIT 1").get() as RootRow | undefined) || null;
  }
  paused() {
    return this.db.pref<boolean>("shelf:paused") === true;
  }
  /** Last verified model key; stored vectors stay usable while Ollama is off. */
  currentModelKey() {
    return this.modelKey || this.db.pref<string>("shelf:modelKey") || null;
  }

  // ---- configuration and lifecycle ----
  /**
   * Save the shelf settings. A new folder or exclusion list first stops
   * indexing, so a walk never sees half-moved rows; the caller rescans.
   */
  async configure(input: Partial<ShelfConfig> & { path: string }): Promise<ShelfConfig> {
    const path = shelfPath(input.path);
    const previous = this.config();
    const config: ShelfConfig = {
      path,
      exclude: [...new Set((input.exclude ?? previous?.exclude ?? DEFAULT_SHELF_EXCLUDE).map((s) => s.trim()).filter(Boolean))].slice(0, 100),
      model: input.model?.trim() || previous?.model || DEFAULT_EMBED_MODEL,
      ollamaUrl: input.ollamaUrl?.trim() || previous?.ollamaUrl || DEFAULT_OLLAMA_URL,
    };
    try {
      new URL(config.ollamaUrl);
    } catch {
      throw new AppError("SHELF_OLLAMA", "Ollama 주소 형식을 확인하세요.");
    }
    const root = this.root();
    const save = (move?: RootMove) => this.db.transaction(() => {
      if (!root)
        this.db.db.prepare("INSERT INTO shelf_roots VALUES(?,?,?,?,?,NULL)")
          .run(randomUUID(), path, basename(path) || path, JSON.stringify(config.exclude), now());
      else {
        // One shelf: a new folder keeps the root id and moves (or drops) its rows.
        if (move) this.moveRoot(root, path, move);
        this.db.db.prepare("UPDATE shelf_roots SET path=?,name=?,exclude=? WHERE id=?").run(path, basename(path) || path, JSON.stringify(config.exclude), root.id);
      }
      this.db.pref("shelf", config);
    });
    if (root && (root.path !== path || previous?.exclude.join("\n") !== config.exclude.join("\n")))
      await this.hold(async () => {
        const move = root.path === path ? undefined : await this.planMove(root, path);
        save(move);
        if (move) this.setJob({ state: "idle", message: MOVE_MESSAGES[move.mode] });
      });
    else save();
    if (previous?.model !== config.model || previous?.ollamaUrl !== config.ollamaUrl) {
      this.modelKey = null;
      this.embeddingPaused = "";
    }
    this.revision++;
    return config;
  }
  /** What moving the shelf to `input` keeps and drops, without changing anything. */
  async previewMove(input: string): Promise<ShelfMovePreview> {
    const to = shelfPath(input);
    const root = this.root();
    if (!root) return { from: null, to, mode: "first", keep: 0, drop: 0, links: 0 };
    const active = new Set((this.db.db.prepare("SELECT id FROM shelf_files WHERE root_id=? AND status!='missing'").all(root.id) as { id: string }[]).map((r) => r.id));
    if (root.path === to) return { from: root.path, to, mode: "same", keep: active.size, drop: 0, links: 0 };
    const move = await this.planMove(root, to);
    const dropped = [...move.rels].filter(([id, rel]) => rel === null && active.has(id)).map(([id]) => id);
    return { from: root.path, to, mode: move.mode, keep: active.size - dropped.length, drop: dropped.length, links: this.projectLinks(dropped) };
  }
  /**
   * Decide how stored rows map into `to`: by path when one folder contains the
   * other, otherwise by finding a sample of the stored files at the new path.
   */
  private async planMove(root: RootRow, to: string): Promise<RootMove> {
    if (!(await rootOnline(to))) throw new AppError("SHELF_PATH", "선택한 폴더를 읽을 수 없습니다. 폴더가 있는지, NAS가 연결돼 있는지 확인하세요.");
    const rows = this.db.db.prepare("SELECT id,rel_path,size,status FROM shelf_files WHERE root_id=? ORDER BY id").all(root.id) as { id: string; rel_path: string; size: number; status: string }[];
    const relation = rootRelation(root.path, to);
    let mode: ShelfMoveMode, prefix = "";
    if (relation) {
      mode = relation.mode;
      prefix = mode === "parent" ? await diskSpelling(to, relation.prefix) : relation.prefix;
    } else {
      // A share mounted under another name, or a copied folder: the same files at the same relative paths.
      const sample = rows.filter((r) => r.status !== "missing").slice(0, 60);
      const found = await Promise.all(sample.map((r) => lstat(join(to, r.rel_path)).then((info) => info.isFile() && info.size === r.size, () => false)));
      mode = sample.length && found.filter(Boolean).length * 2 >= sample.length ? "remount" : "new";
    }
    return { mode, rels: new Map(rows.map((r) => [r.id, movedRel(mode, prefix, r.rel_path)])) };
  }
  private projectLinks(fileIds: string[]) {
    if (!fileIds.length) return 0;
    return (this.db.db.prepare(
      "SELECT count(DISTINCT a.work_id) AS n FROM attachments a JOIN project_works pw ON pw.work_id=a.work_id WHERE json_extract(a.data,'$.shelfFileId') IN (SELECT value FROM json_each(?))",
    ).get(JSON.stringify(fileIds)) as { n: number }).n;
  }
  /**
   * Re-root the index inside the caller's transaction. Kept rows take their new
   * relative paths with their ids, metadata and embeddings; the rest leave the
   * index, and links to them keep pointing at the PDF where it still is.
   */
  private moveRoot(root: RootRow, path: string, move: RootMove) {
    const moved: RootRow = { ...root, path, name: basename(path) || path };
    const kept = [...move.rels].filter((entry): entry is [string, string] => entry[1] !== null);
    const works = new Set<string>();
    for (const [id, rel] of move.rels) {
      if (rel !== null) continue;
      const work = this.forget(id, root.path);
      if (work) works.add(work);
    }
    this.dropOrphans(works);
    const folders = new Set([""]);
    for (const [, rel] of kept) for (let folder = parentRel(rel); folder !== null; folder = parentRel(folder)) folders.add(folder);
    const folder = this.db.db.prepare("INSERT INTO shelf_folders VALUES(?,?,?,?,?,1) ON CONFLICT(root_id,rel_path) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,present=1");
    for (const rel of folders)
      folder.run(folderId(root.id, rel), root.id, rel, parentRel(rel) === null ? null : folderId(root.id, parentRel(rel)!), rel ? basename(rel) : moved.name);
    // Two passes: renaming in place could meet another row's old path (UNIQUE(root_id,rel_path)).
    const park = this.db.db.prepare("UPDATE shelf_files SET rel_path=? WHERE id=?");
    for (const [id] of kept) park.run(`\u0000${id}`, id);
    const place = this.db.db.prepare("UPDATE shelf_files SET rel_path=?,folder_id=? WHERE id=?");
    for (const [id, rel] of kept) place.run(rel, folderId(root.id, parentRel(rel) ?? ""), id);
    this.db.db.prepare("DELETE FROM shelf_folders WHERE root_id=? AND id NOT IN (SELECT value FROM json_each(?))")
      .run(root.id, JSON.stringify([...folders].map((rel) => folderId(root.id, rel))));
    for (const [id] of kept) this.syncAttachmentPath(id, moved);
  }
  /** Take a file out of the index. Its attachments become plain links to the PDF at `rootPath`. */
  private forget(id: string, rootPath: string): string | null {
    const row = this.file(id);
    if (!row) return null;
    const path = join(rootPath, row.rel_path);
    for (const r of this.db.db.prepare("SELECT data FROM attachments WHERE id=? OR json_extract(data,'$.shelfFileId')=?").all(row.attachment_id || "", id) as { data: string }[]) {
      const a = JSON.parse(r.data) as Attachment;
      this.db.saveAttachment({ ...a, path, name: basename(path), status: "이전 서고 PDF · 원본 위치 유지", shelfFileId: undefined });
    }
    this.db.db.prepare("DELETE FROM shelf_files WHERE id=?").run(id);
    return row.work_id;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan("timer"), RESCAN_MS);
    this.timer.unref?.();
    this.startTimer = setTimeout(() => void this.scan("startup"), 2000);
    this.startTimer.unref?.();
  }
  stop() {
    clearInterval(this.timer);
    clearTimeout(this.startTimer);
    clearTimeout(this.followUp);
    this.timer = undefined;
    this.control?.abort();
  }
  async wait() {
    await this.running;
  }
  command(action: "pause" | "resume" | "cancel" | "retryFailed" | "reresolve" | "reembed" | "confirmMissing" | "scan") {
    if (action === "pause") {
      this.db.pref("shelf:paused", true);
      this.control?.abort();
      this.setJob({ state: "paused", message: "서고 색인 일시정지 · 열람과 검색은 그대로 쓸 수 있습니다." });
      return;
    }
    if (action === "cancel") {
      this.control?.abort();
      return;
    }
    if (action === "reresolve")
      this.db.db.prepare("UPDATE shelf_files SET stage='extracted' WHERE stage='resolved' AND status IN ('review','provisional')").run();
    if (action === "retryFailed")
      this.db.db.prepare("UPDATE shelf_files SET status='provisional',stage=CASE WHEN hash IS NULL THEN 'found' ELSE 'hashed' END,info=json_remove(info,'$.error') WHERE status='failed'").run();
    if (action === "reembed") {
      this.db.db.prepare("DELETE FROM work_embeddings WHERE work_id IN (SELECT work_id FROM shelf_files WHERE work_id IS NOT NULL)").run();
      this.vectors.loaded = false;
      this.embeddingPaused = "";
    }
    if (action === "confirmMissing") this.confirmMissing = true;
    if (action === "resume") {
      this.db.pref("shelf:paused", false);
      this.clearResolverPause();
      this.embeddingPaused = "";
    }
    void this.scan(action);
  }

  // ---- the indexing cycle ----
  scan(_reason: string): Promise<void> {
    if (this.running) return this.running;
    const root = this.root(), config = this.config();
    if (!root || !config || this.held) return Promise.resolve();
    if (this.paused()) {
      this.setJob({ state: "paused", message: "서고 색인 일시정지 · 열람과 검색은 그대로 쓸 수 있습니다." });
      return Promise.resolve();
    }
    const control = new AbortController();
    this.control = control;
    this.running = this.cycle(root, config, control.signal)
      .catch((error) => {
        if (control.signal.aborted) {
          if (!this.paused() && !this.held) this.setJob({ state: "idle", message: "서고 색인을 중단했습니다. 처리한 파일은 보존되며 다음 스캔에서 이어집니다." });
          return;
        }
        const offline = error instanceof AppError && error.code === "SHELF_OFFLINE";
        this.setJob({ state: offline ? "offline" : "idle", message: error instanceof AppError ? error.message : "서고 색인 중 오류가 발생했습니다. 다음 스캔에서 이어집니다." });
        if (offline) this.retrySoon();
      })
      .finally(() => {
        this.control = null;
        this.running = null;
        this.managed = null;
        this.revision++;
        this.emit({ type: "changed" });
      });
    return this.running;
  }

  private async cycle(root: RootRow, config: ShelfConfig, signal: AbortSignal) {
    this.setJob({ state: "scanning", message: "서고 폴더를 확인하고 있습니다." });
    if (!(await rootOnline(root.path))) {
      this.online = false;
      this.setJob({ state: "offline", message: "서고 오프라인 · NAS 연결이 필요합니다. 서지·초록·추천은 계속 쓸 수 있습니다." });
      this.retrySoon();
      return;
    }
    this.online = true;
    await this.removeStaleTemps(root);
    const walked = await walk(root.path, config.exclude, signal);
    // A share can disappear mid-walk; never turn an unmount into missing files.
    if (!(await rootOnline(root.path))) {
      this.online = false;
      this.setJob({ state: "offline", message: "스캔 중 서고 연결이 끊겼습니다. 파일 상태를 바꾸지 않았습니다." });
      this.retrySoon();
      return;
    }
    const confirm = await this.applyScan(root, walked, signal);
    this.modelKey = null; // re-check the model digest once per cycle
    const processed = new Set<string>();
    this.setJob({ state: "indexing", message: "서고 색인 중", ...this.progress(root.id) });
    while (true) {
      signal.throwIfAborted();
      const rows = this.nextChunk(root.id).filter((row) => !processed.has(row.id));
      if (!rows.length) break;
      for (const row of rows) processed.add(row.id);
      await this.processChunk(root, rows, signal);
      this.setJob({ state: "indexing", message: this.indexMessage(), ...this.progress(root.id) }, true);
    }
    await this.embed(signal);
    this.db.db.prepare("UPDATE shelf_roots SET last_scan_at=? WHERE id=?").run(now(), root.id);
    if (!this.resolverActive() && this.timer) {
      // Resume bibliographic checks when the OpenAlex pause ends rather than at the next 30-minute scan.
      clearTimeout(this.followUp);
      this.followUp = setTimeout(() => void this.scan("resolver"), Math.min(this.resolverPausedUntil - Date.now() + 1000, RESCAN_MS));
      this.followUp.unref?.();
    }
    const counts = this.counts(root.id);
    this.setJob(confirm
      ? { state: "confirm", message: `서고 파일 ${confirm.missing}개가 한 번에 사라졌습니다. 마운트를 확인한 뒤 '사라진 파일 반영'을 누르세요.`, confirm }
      : { state: "idle", message: `서고 ${counts.works.toLocaleString()}편 · 확인 필요 ${this.reviewCount(root.id).toLocaleString()}편${counts.stages.extracted ? ` · 서지 확인 대기 ${counts.stages.extracted.toLocaleString()}편` : ""}${this.resolverPausedUntil > Date.now() ? ` · ${this.resolverReason}` : ""}${this.embeddingPaused ? ` · ${this.embeddingPaused}` : ""}` });
  }

  /** A share that is not readable yet (just mounted, permission pending) is retried within minutes. */
  private retrySoon() {
    if (!this.timer) return;
    clearTimeout(this.followUp);
    this.followUp = setTimeout(() => void this.scan("offline"), OFFLINE_RETRY_MS);
    this.followUp.unref?.();
  }
  private async assertOnline(root: RootRow) {
    if (await rootOnline(root.path)) return;
    this.online = false;
    throw new AppError("SHELF_OFFLINE", "색인 중 서고 연결이 끊겼습니다. 처리한 파일은 보존되며 다시 연결되면 이어집니다.");
  }
  private indexMessage() {
    return `서고 색인 중${this.resolverPausedUntil > Date.now() ? ` · 서지 확인 대기: ${this.resolverReason}` : ""}${this.embeddingPaused ? ` · ${this.embeddingPaused}` : ""}`;
  }
  private progress(rootId: string) {
    const row = this.db.db.prepare("SELECT count(*) AS total,sum(stage='resolved' OR status IN ('failed','missing') OR (stage='extracted' AND ?)) AS done FROM shelf_files WHERE root_id=?")
      .get(this.resolverActive() ? 0 : 1, rootId) as { total: number; done: number | null };
    return { total: row.total, done: row.done || 0 };
  }
  private resolverActive() {
    return this.resolverPausedUntil <= Date.now();
  }
  private nextChunk(rootId: string): FileRow[] {
    return this.db.db.prepare(
      "SELECT * FROM shelf_files WHERE root_id=? AND status NOT IN ('missing','failed') AND (stage IN ('found','hashed') OR (stage='extracted' AND ?)) ORDER BY rel_path LIMIT ?",
    ).all(rootId, this.resolverActive() ? 1 : 0, CHUNK) as FileRow[];
  }

  /** Apply a walk: folders, moves, new files with filename-based provisional works, missing marks. */
  async applyScan(root: RootRow, walked: Walked, signal?: AbortSignal): Promise<{ missing: number; total: number } | null> {
    const known = this.db.db.prepare("SELECT id,rel_path,size,status FROM shelf_files WHERE root_id=?").all(root.id) as { id: string; rel_path: string; size: number; status: string }[];
    const plan = planScan(known, walked);
    const stamp = now();
    const confirmed = this.confirmMissing;
    this.db.transaction(() => {
      this.db.db.prepare("UPDATE shelf_folders SET present=0 WHERE root_id=?").run(root.id);
      for (const rel of walked.folders)
        this.db.db.prepare("INSERT INTO shelf_folders VALUES(?,?,?,?,?,1) ON CONFLICT(root_id,rel_path) DO UPDATE SET present=1")
          .run(folderId(root.id, rel), root.id, rel, parentRel(rel) === null ? null : folderId(root.id, parentRel(rel)!), rel ? basename(rel) : root.name);
      for (const { id, file } of plan.seen) {
        const row = this.file(id)!;
        const changed = row.hashed_size !== null && (row.hashed_size !== file.size || row.hashed_mtime !== file.mtime);
        const info = parseInfo(row);
        const status = row.status === "missing" ? (info.error ? "failed" : ((info as { statusBeforeMissing?: ShelfStatus }).statusBeforeMissing || "provisional")) : row.status;
        this.db.db.prepare("UPDATE shelf_files SET size=?,mtime=?,seen_at=?,missing_since=NULL,status=?,stage=? WHERE id=?")
          .run(file.size, file.mtime, stamp, status, changed ? "found" : row.stage, id);
      }
      for (const { id, to } of plan.moves) {
        const row = this.file(id)!;
        const info = parseInfo(row) as ShelfFileInfo & { statusBeforeMissing?: ShelfStatus };
        this.db.db.prepare("UPDATE shelf_files SET rel_path=?,folder_id=?,size=?,mtime=?,seen_at=?,missing_since=NULL,status=? WHERE id=?")
          .run(to.rel, folderId(root.id, to.folder), to.size, to.mtime, stamp, row.status === "missing" ? info.statusBeforeMissing || "provisional" : row.status, id);
        this.syncAttachmentPath(id, root);
      }
      const markMissing = !plan.needsConfirm || confirmed;
      if (markMissing)
        for (const row of plan.vanished) {
          if (row.status === "missing") continue;
          const current = this.file(row.id)!;
          this.db.db.prepare("UPDATE shelf_files SET status='missing',missing_since=?,info=? WHERE id=?")
            .run(stamp, JSON.stringify({ ...parseInfo(current), statusBeforeMissing: current.status }), row.id);
        }
      if (markMissing) this.confirmMissing = false;
    });
    // New files get filename-based records right away so folders are browsable during indexing.
    // Commit in batches so the service keeps answering the UI during a first 8,000-file scan.
    for (let i = 0; i < plan.fresh.length; i += 250) {
      signal?.throwIfAborted();
      this.db.transaction(() => {
        for (const file of plan.fresh.slice(i, i + 250)) {
          if (this.db.db.prepare("SELECT 1 FROM shelf_files WHERE root_id=? AND rel_path=?").get(root.id, file.rel)) continue;
          const parsed = parseShelfFilename(basename(file.rel));
          const work = this.db.upsert(blankWork({
            title: parsed?.title || basename(file.rel).replace(/\.pdf$/i, ""),
            authors: parsed?.authors || [],
            year: parsed?.year ?? null,
            source: "shelf",
            raw: { filename: basename(file.rel) },
            citekey: "",
          })).work;
          this.db.db.prepare("INSERT INTO shelf_files VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,NULL,'found','provisional',?,?,NULL)")
            .run(randomUUID(), root.id, folderId(root.id, file.folder), file.rel, file.size, file.mtime, work.id, JSON.stringify({ parsed } satisfies ShelfFileInfo), stamp);
          this.ftsRefresh(work.id);
        }
      });
      if (plan.fresh.length > 250) {
        this.setJob({ state: "scanning", message: `새 PDF 등록 ${Math.min(i + 250, plan.fresh.length).toLocaleString()}/${plan.fresh.length.toLocaleString()}`, done: Math.min(i + 250, plan.fresh.length), total: plan.fresh.length }, true);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    this.revision++;
    this.emit({ type: "changed" });
    return plan.needsConfirm && !confirmed
      ? { missing: plan.vanished.filter((r) => r.status !== "missing").length, total: known.length }
      : null;
  }

  private async processChunk(root: RootRow, rows: FileRow[], signal: AbortSignal) {
    const hashes = new Map<string, string>();
    await pool(rows.filter((r) => r.stage === "found"), 2, async (row) => {
      signal.throwIfAborted();
      const path = join(root.path, row.rel_path);
      try {
        hashes.set(row.id, await hashFile(path, signal));
      } catch (error) {
        signal.throwIfAborted();
        await this.assertOnline(root);
        this.fail(row.id, `파일을 읽지 못했습니다 (${(error as NodeJS.ErrnoException)?.code || "unknown"})`);
      }
    });
    // Apply in path order so the first copy of identical bytes is always the primary.
    for (const row of rows) if (hashes.has(row.id)) this.afterHash(root, row.id, hashes.get(row.id)!, row.size, row.mtime);
    const hashed = rows.map((r) => this.file(r.id)).filter((r): r is FileRow => !!r && r.stage === "hashed" && r.status !== "missing");
    await pool(hashed, 3, async (row) => {
      signal.throwIfAborted();
      const result = row.size > 100 * 1024 * 1024
        ? { title: "", authors: "", dois: [], pages: null, text: "", status: "100MB 초과 · 추출 생략" }
        : await extractPdf(join(root.path, row.rel_path), this.workerPath, signal, "shelf");
      // An unmounted share looks like an unreadable PDF; keep the row for the next scan.
      if (!result.pages) await this.assertOnline(root);
      this.afterExtract(row.id, result);
    });
    if (this.resolverActive()) {
      const pending = rows.map((r) => this.file(r.id)).filter((r): r is FileRow => !!r && r.stage === "extracted" && r.status !== "missing");
      await this.resolveRows(pending, signal);
    }
    await this.embed(signal, rows.map((r) => this.file(r.id)?.work_id).filter((id): id is string => !!id));
    this.revision++;
    if (Date.now() - this.lastChanged > 5000) {
      this.lastChanged = Date.now();
      this.emit({ type: "changed" });
    }
  }

  private managedHashes() {
    if (!this.managed) {
      this.managed = new Map();
      for (const row of this.db.db.prepare("SELECT work_id,json_extract(data,'$.hash') AS hash FROM attachments WHERE json_extract(data,'$.shelfFileId') IS NULL").all() as { work_id: string; hash: string }[])
        if (row.hash) this.managed.set(row.hash, row.work_id);
    }
    return this.managed;
  }

  afterHash(root: RootRow, id: string, hash: string, size: number, mtime: number) {
    this.db.transaction(() => {
      const current = this.file(id);
      if (!current) return;
      const renamed = this.db.db.prepare("SELECT * FROM shelf_files WHERE root_id=? AND hash=? AND status='missing' AND id!=? LIMIT 1").get(root.id, hash, id) as FileRow | undefined;
      if (renamed) {
        // A renamed file: keep the old row (work, embedding, attachment) at the new location.
        const info = parseInfo(renamed) as ShelfFileInfo & { statusBeforeMissing?: ShelfStatus };
        this.db.db.prepare("DELETE FROM shelf_files WHERE id=?").run(id);
        this.db.db.prepare("UPDATE shelf_files SET rel_path=?,folder_id=?,size=?,mtime=?,hashed_size=?,hashed_mtime=?,seen_at=?,missing_since=NULL,status=? WHERE id=?")
          .run(current.rel_path, current.folder_id, size, mtime, size, mtime, now(), info.statusBeforeMissing || "provisional", renamed.id);
        this.syncAttachmentPath(renamed.id, root);
        if (current.work_id && current.work_id !== renamed.work_id) this.dropWorkIfOrphan(current.work_id);
        return;
      }
      const twin = this.db.db.prepare("SELECT * FROM shelf_files WHERE root_id=? AND hash=? AND status!='missing' AND id!=? AND work_id IS NOT NULL AND json_extract(info,'$.duplicateOf') IS NULL ORDER BY rel_path LIMIT 1").get(root.id, hash, id) as FileRow | undefined;
      if (twin) {
        // A copy's identity is its primary's; review and status counts follow the primary file.
        this.db.db.prepare("UPDATE shelf_files SET hash=?,hashed_size=?,hashed_mtime=?,stage='resolved',status=?,info=? WHERE id=?")
          .run(hash, size, mtime, twin.status === "auxiliary" ? "auxiliary" : "ok", JSON.stringify({ ...parseInfo(current), duplicateOf: twin.id }), id);
        this.moveFile(id, twin.work_id!);
        return;
      }
      this.db.db.prepare("UPDATE shelf_files SET hash=?,hashed_size=?,hashed_mtime=?,stage='hashed',info=json_remove(info,'$.duplicateOf') WHERE id=?").run(hash, size, mtime, id);
      const managed = this.managedHashes().get(hash);
      if (managed && managed !== current.work_id && this.exists(managed)) {
        // Same bytes as a PDF the app already manages: that work's metadata is authoritative.
        this.moveFile(id, managed);
        this.setInfo(id, { resolution: { method: "hash", at: now() } });
        this.db.db.prepare("UPDATE shelf_files SET status='ok' WHERE id=?").run(id);
      }
      this.ensureAttachment(id, root);
    });
  }

  afterExtract(id: string, result: Awaited<ReturnType<typeof extractPdf>>) {
    this.db.transaction(() => {
      const row = this.file(id);
      if (!row) return;
      const info = parseInfo(row);
      const dois = [...new Set(result.dois.map(normalizeDoi).filter((d): d is string => !!d))].slice(0, 5);
      const next: ShelfFileInfo = {
        ...info,
        metadataTitle: result.title.slice(0, 500),
        dois,
        page1: pageLead(result.text),
        abstract: extractAbstractCandidate(result.text) || undefined,
        pages: result.pages,
        extraction: result.status,
      };
      const auxiliary = isAuxiliaryPdf(result) || isAuxiliaryPdf({ title: info.parsed?.title || "", text: "" });
      const stage: ShelfStage = auxiliary || info.resolution?.method === "hash" || info.resolution?.method === "app" ? "resolved" : "extracted";
      this.db.db.prepare("UPDATE shelf_files SET info=?,stage=?,status=? WHERE id=?")
        .run(JSON.stringify(next), stage, auxiliary ? "auxiliary" : row.status, id);
      if (row.work_id && next.abstract) {
        const work = this.db.get(row.work_id);
        if (!work.abstract && work.edits.abstract === undefined)
          this.writeWork({ ...work, abstract: next.abstract, raw: { ...work.raw, abstractSource: "pdf" } });
      }
    });
  }

  private resolveInput(row: FileRow) {
    const info = parseInfo(row);
    const title = info.parsed?.title || info.metadataTitle || "";
    return { fileId: row.id, title, year: info.parsed?.year ?? null, firstAuthor: info.parsed?.authors[0], dois: info.dois || [] };
  }
  private async resolveRows(rows: FileRow[], signal: AbortSignal) {
    if (!rows.length) return;
    let resolutions: Map<string, Resolution>;
    try {
      resolutions = await this.resolver.resolve(rows.map((r) => this.resolveInput(r)), signal, () => {
        signal.throwIfAborted();
        this.db.usage("openalex", "shelf");
      });
    } catch (error) {
      signal.throwIfAborted();
      const partial = (error as { partial?: Map<string, Resolution> }).partial;
      if (partial) for (const [id, resolution] of partial) this.applyResolution(id, resolution);
      const code = error instanceof AppError ? error.code : "NETWORK";
      const resetMs = (error as { resetMs?: number }).resetMs;
      // Only the bibliographic step waits; hashing, extraction, browsing and embedding go on.
      // OpenAlex resets daily credits at midnight UTC and reports the remaining seconds.
      const wait = ["DAILY_BUDGET", "SHELF_RESERVE"].includes(code)
        ? (resetMs ?? 6 * 3600_000) + 5 * 60_000
        : code === "RATE_LIMIT" ? resetMs ?? 60_000 : code === "API_KEY" ? 6 * 3600_000 : 10 * 60_000;
      const until = Date.now() + wait;
      const at = new Date(until).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      this.pauseResolver(code, until, code === "DAILY_BUDGET" ? `OpenAlex 일일 예산 소진 · ${at} 이후 이어서 확인`
        : code === "SHELF_RESERVE" ? `OpenAlex 예산의 20%는 검색용으로 남김 · ${at} 이후 이어서 확인`
        : code === "API_KEY" ? "OpenAlex 키 확인 필요" : code === "RATE_LIMIT" ? "OpenAlex 요청 한도 대기" : "OpenAlex 연결 실패 · 잠시 후 재시도");
      return;
    }
    if (this.resolverCode) this.clearResolverPause();
    for (const row of rows) {
      const resolution = resolutions.get(row.id);
      if (resolution) this.applyResolution(row.id, resolution);
    }
  }

  applyResolution(id: string, resolution: Resolution) {
    this.db.transaction(() => {
      const row = this.file(id);
      if (!row?.work_id) return;
      if (resolution.kind !== "accept") {
        this.db.db.prepare("UPDATE shelf_files SET stage='resolved',status=?,info=? WHERE id=?")
          .run(resolution.kind === "review" ? "review" : "provisional", JSON.stringify({ ...parseInfo(row), candidates: resolution.candidates, resolution: { method: "provisional", note: resolution.note, at: now() } }), id);
        return;
      }
      try {
        const workId = this.adopt(row, resolution.work);
        this.db.db.prepare("UPDATE shelf_files SET stage='resolved',status='ok',info=? WHERE id=?").run(
          JSON.stringify({ ...parseInfo(this.file(id)!), candidates: undefined, error: undefined, resolution: { method: resolution.method, similarity: Math.round(resolution.similarity * 1000) / 1000, doi: resolution.doi, at: now() } }),
          id,
        );
        this.ftsRefresh(workId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "IDENTITY_CONFLICT") throw error;
        this.db.db.prepare("UPDATE shelf_files SET stage='resolved',status='review',info=? WHERE id=?")
          .run(JSON.stringify({ ...parseInfo(row), error: error.message, resolution: { method: "provisional", note: error.message, at: now() } }), id);
      }
    });
  }

  /**
   * Put verified metadata on the file's work. If the identifiers already belong
   * to another work (e.g. a project paper), link the file there; otherwise keep
   * the provisional id so saved references stay valid.
   */
  private adopt(row: FileRow, found: Work): string {
    const provisional = this.db.get(row.work_id!);
    const incoming: Work = { ...found, raw: { ...slimRaw(found.raw), ...(found.raw.abstractSource ? { abstractSource: found.raw.abstractSource } : {}) } };
    if (incoming.abstract && !incoming.raw.abstractSource) incoming.raw.abstractSource = "openalex";
    if (!incoming.abstract && provisional.abstract && provisional.raw?.abstractSource === "pdf") {
      incoming.abstract = provisional.abstract;
      incoming.raw.abstractSource = "pdf";
    }
    const match = this.db.match(incoming);
    if (match.conflict) throw new AppError("IDENTITY_CONFLICT", match.conflict);
    if (match.id && match.id !== provisional.id) {
      const { work } = this.db.upsert(incoming);
      this.moveFile(row.id, work.id);
      return work.id;
    }
    if (match.id === provisional.id) return this.db.upsert(incoming).work.id;
    return this.db.upsert({ ...incoming, id: provisional.id, citekey: provisional.citekey, edits: provisional.edits }).work.id;
  }

  // ---- storing PDFs in the inbox ----
  /** The shelf root, checked readable now. Downloads and imports are stored there, so an offline shelf stops them. */
  async writableRoot(): Promise<RootRow> {
    const root = this.root();
    if (!root) throw new AppError("SHELF_NONE", "서고를 설정하지 않았습니다.");
    if (!(await rootOnline(root.path))) {
      this.online = false;
      throw new AppError("SHELF_OFFLINE", `서고(${root.path})가 연결되지 않아 PDF를 저장할 수 없습니다. NAS를 연결한 뒤 다시 시도하세요.`);
    }
    this.online = true;
    return root;
  }
  /**
   * Store a verified PDF of a work in the inbox (the shelf root) under the
   * shelf's `연도 - 저자 - 제목.pdf` name, or link the work to identical bytes
   * already on the shelf. The file is registered with the work at once, so the
   * index extracts it without another bibliographic lookup. The app only adds
   * files to the root; moving them into folders stays with the shelf's intake tool.
   * Copies of the same bytes in the app's own folder become links and are removed.
   */
  async deposit(source: string, workId: string, options: { hash?: string; signal?: AbortSignal; method?: "app" | "hash"; fields?: Partial<Attachment> } = {}): Promise<Attachment> {
    const { signal } = options;
    const root = await this.writableRoot();
    const hash = options.hash || (await hashFile(source, signal));
    const work = this.db.get(workId);
    let fileId = (this.db.db.prepare("SELECT id FROM shelf_files WHERE root_id=? AND hash=? AND status!='missing' ORDER BY json_extract(info,'$.duplicateOf') IS NOT NULL, rel_path LIMIT 1").get(root.id, hash) as { id: string } | undefined)?.id;
    if (!fileId) {
      const temp = join(root.path, `${TEMP_PREFIX}${randomUUID()}.part`);
      let name: string;
      try {
        await copyFile(source, temp);
        if ((await hashFile(temp, signal)) !== hash) throw new AppError("COPY_HASH", "서고에 복사한 PDF의 내용이 원본과 다릅니다.");
        signal?.throwIfAborted();
        name = await freeName(root.path, formatShelfFilename(work));
        await rename(temp, join(root.path, name));
      } finally {
        await rm(temp, { force: true });
      }
      const info = await stat(join(root.path, name));
      const id = randomUUID();
      this.db.transaction(() => {
        this.db.db.prepare("INSERT INTO shelf_folders VALUES(?,?,'',NULL,?,1) ON CONFLICT(root_id,rel_path) DO UPDATE SET present=1").run(folderId(root.id, ""), root.id, root.name);
        const fileInfo: ShelfFileInfo = { parsed: parseShelfFilename(name), resolution: { method: options.method || "app", at: now() } };
        this.db.db.prepare("INSERT INTO shelf_files VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'hashed','ok',?,?,NULL)")
          .run(id, root.id, folderId(root.id, ""), name, info.size, Math.trunc(info.mtimeMs), hash, info.size, Math.trunc(info.mtimeMs), workId, JSON.stringify(fileInfo), now());
        // The work's earlier copy of these bytes keeps its id (and download details) as the shelf file's attachment.
        const own = this.db.attachments(workId).find((a) => a.hash === hash && !a.shelfFileId);
        if (own) this.db.db.prepare("UPDATE shelf_files SET attachment_id=? WHERE id=?").run(own.id, id);
      });
      fileId = id;
    }
    const stored = fileId;
    const replaced = new Set<string>();
    const attachment = this.db.transaction(() => {
      const copies = (this.db.db.prepare("SELECT data FROM attachments WHERE json_extract(data,'$.hash')=? AND json_extract(data,'$.shelfFileId') IS NULL").all(hash) as { data: string }[])
        .map((r) => JSON.parse(r.data) as Attachment);
      for (const workToLink of new Set([workId, ...copies.map((a) => a.workId)])) {
        this.attachTo(stored, workToLink);
        for (const left of this.db.attachments(workToLink).filter((a) => a.hash === hash && !a.shelfFileId)) {
          this.db.db.prepare("DELETE FROM attachments WHERE id=?").run(left.id);
          if (left.mode === "managed") replaced.add(left.path);
        }
      }
      for (const a of copies) if (a.mode === "managed") replaced.add(a.path);
      const linked = this.db.attachments(workId).find((a) => a.shelfFileId === stored)!;
      const result = { ...linked, ...options.fields };
      this.db.saveAttachment(result);
      this.ftsRefresh(workId);
      return result;
    });
    // Only files inside the app's own folder that nothing points to any more.
    for (const path of replaced)
      if (path === join(this.db.root, "attachments", hash + ".pdf") && !this.db.db.prepare("SELECT 1 FROM attachments WHERE json_extract(data,'$.path')=? LIMIT 1").get(path))
        await rm(path, { force: true });
    this.managed = null;
    this.revision++;
    return attachment;
  }
  /** Distinct PDFs still kept in the app's own folder (from before the shelf stored downloads). */
  managedCount() {
    return (this.db.db.prepare("SELECT count(DISTINCT json_extract(data,'$.hash')) AS n FROM attachments WHERE json_extract(data,'$.mode')='managed'").get() as { n: number }).n;
  }
  /**
   * Move the PDFs kept in the app's own folder into the inbox. Identical bytes on
   * the shelf are linked instead. When the shelf already holds the paper as a
   * different file, both stay and the paper is reported, never duplicated.
   */
  async adoptManaged(signal?: AbortSignal): Promise<ShelfAdoptResult> {
    const root = await this.writableRoot();
    const groups = new Map<string, Attachment[]>();
    for (const { data } of this.db.db.prepare("SELECT data FROM attachments WHERE json_extract(data,'$.mode')='managed' ORDER BY rowid").all() as { data: string }[]) {
      const a = JSON.parse(data) as Attachment;
      groups.set(a.hash, [...(groups.get(a.hash) || []), a]);
    }
    const result: ShelfAdoptResult = { moved: 0, linked: 0, kept: [], failed: [] };
    const hasShelfPdf = this.db.db.prepare("SELECT 1 FROM attachments a JOIN shelf_files f ON f.id=json_extract(a.data,'$.shelfFileId') WHERE a.work_id=? AND f.status!='missing' LIMIT 1");
    const inProject = this.db.db.prepare("SELECT 1 FROM project_works WHERE work_id=? LIMIT 1");
    for (const [hash, group] of groups) {
      signal?.throwIfAborted();
      const onShelf = !!this.db.db.prepare("SELECT 1 FROM shelf_files WHERE root_id=? AND hash=? AND status!='missing'").get(root.id, hash);
      if (!onShelf && group.every((a) => hasShelfPdf.get(a.workId))) {
        result.kept.push(...group.map((a) => a.workId));
        continue;
      }
      try {
        if ((await hashFile(group[0].path, signal)) !== hash) throw new AppError("HASH_MISMATCH", "보관 PDF의 내용이 기록과 다릅니다.");
        const primary = group.find((a) => inProject.get(a.workId)) || group[0];
        await this.deposit(group[0].path, primary.workId, { hash, signal, method: "hash", fields: { status: "앱 보관 PDF · 서고 수신함으로 옮김" } });
        if (onShelf) result.linked++;
        else result.moved++;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof AppError && error.code === "SHELF_OFFLINE") throw error;
        result.failed.push({ workId: group[0].workId, reason: error instanceof AppError ? error.message : `파일 접근 실패 (${(error as NodeJS.ErrnoException)?.code || "unknown"})` });
      }
    }
    this.emit({ type: "changed" });
    return result;
  }
  /** Temporary files of interrupted deposits; a deposit in progress is younger than an hour. */
  private async removeStaleTemps(root: RootRow) {
    for (const name of (await readdir(root.path).catch(() => [] as string[])).filter((n) => n.startsWith(TEMP_PREFIX) && n.endsWith(".part"))) {
      const info = await lstat(join(root.path, name)).catch(() => null);
      if (info?.isFile() && Date.now() - info.mtimeMs > TEMP_MAX_AGE_MS) await rm(join(root.path, name), { force: true });
    }
  }

  // ---- links between files, works and attachments ----
  file(id: string): FileRow | null {
    return (this.db.db.prepare("SELECT * FROM shelf_files WHERE id=?").get(id) as FileRow | undefined) || null;
  }
  private exists(workId: string) {
    return !!this.db.db.prepare("SELECT 1 FROM works WHERE id=?").get(workId);
  }
  private setInfo(id: string, patch: Partial<ShelfFileInfo>) {
    const row = this.file(id);
    if (row) this.db.db.prepare("UPDATE shelf_files SET info=? WHERE id=?").run(JSON.stringify({ ...parseInfo(row), ...patch }), id);
  }
  private fail(id: string, message: string) {
    this.setInfo(id, { error: message });
    this.db.db.prepare("UPDATE shelf_files SET status='failed' WHERE id=?").run(id);
  }
  private attachmentOrNull(id: string): Attachment | null {
    const row = this.db.db.prepare("SELECT data FROM attachments WHERE id=?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  /** Every attachment made from this file (its own and ones linked to project papers) follows a move. */
  private syncAttachmentPath(id: string, root: RootRow) {
    const row = this.file(id);
    if (!row) return;
    for (const r of this.db.db.prepare("SELECT data FROM attachments WHERE id=? OR json_extract(data,'$.shelfFileId')=?").all(row.attachment_id || "", id) as { data: string }[]) {
      const a = JSON.parse(r.data) as Attachment;
      this.db.saveAttachment({ ...a, path: join(root.path, row.rel_path), name: basename(row.rel_path), exists: true });
    }
  }
  /**
   * Give a paper outside the shelf a linked attachment to a shelf PDF (no copy,
   * no download). The shelf's own record is left as it is.
   */
  attachTo(fileId: string, workId: string) {
    const row = this.file(fileId);
    const root = this.root();
    if (row && !row.hash && root && row.root_id === root.id && row.status !== "missing") throw new AppError("SHELF_PENDING", "서고 PDF를 아직 색인하고 있습니다. 색인이 끝난 뒤 다시 시도하세요.");
    if (!row?.hash || !root || row.root_id !== root.id || row.status === "missing") throw new AppError("NOT_FOUND", "연결할 서고 PDF를 찾을 수 없습니다. 서고를 다시 스캔하세요.");
    this.db.get(workId);
    if (row.work_id === workId) return this.ensureAttachment(fileId, root);
    const existing = this.db.attachments(workId).find((a) => a.shelfFileId === fileId || a.hash === row.hash);
    this.db.saveAttachment({
      ...existing,
      id: existing?.id || randomUUID(),
      workId,
      name: basename(row.rel_path),
      path: join(root.path, row.rel_path),
      hash: row.hash,
      mode: "linked",
      size: row.size,
      status: "서고 PDF 연결 · 다운로드 없음",
      exists: true,
      shelfFileId: fileId,
    });
  }
  fileDetails(fileId: string) {
    const row = this.file(fileId);
    if (!row) throw new AppError("NOT_FOUND", "서고 파일을 찾을 수 없습니다.");
    const folder = this.db.db.prepare("SELECT rel_path FROM shelf_folders WHERE id=?").get(row.folder_id) as { rel_path: string } | undefined;
    const info = parseInfo(row);
    return {
      fileId: row.id,
      workId: row.work_id,
      relPath: row.rel_path,
      folder: folder?.rel_path || "수신함",
      size: row.size,
      stage: row.stage,
      status: row.status,
      missingSince: row.missing_since,
      parsed: info.parsed || null,
      dois: info.dois || [],
      extraction: info.extraction || "",
      resolution: info.resolution || null,
      candidates: info.candidates || [],
      duplicateOf: info.duplicateOf || null,
      error: info.error || null,
      abstractFromPdf: !!info.abstract,
    };
  }
  private pulling = false;
  /** Download the configured embedding model on request (378 MB–1.3 GB). */
  async pullModel() {
    const config = this.config();
    if (!config || this.pulling) return;
    this.pulling = true;
    this.setJob({ ...this.job, message: `${config.model} 모델을 받는 중입니다. 완료되면 임베딩을 시작합니다.` });
    try {
      await this.ollama.pull(config.model, AbortSignal.timeout(60 * 60 * 1000));
      this.modelKey = null;
      this.embeddingPaused = "";
      this.setJob({ state: "idle", message: `${config.model} 모델을 받았습니다.` });
      void this.scan("model");
    } catch (error) {
      this.setJob({ state: "idle", message: error instanceof AppError ? error.message : "모델을 받지 못했습니다. Ollama 연결을 확인하세요." });
    } finally {
      this.pulling = false;
    }
  }
  /** One `linked` attachment per shelf file; duplicates of the same bytes do not add PDFs. */
  ensureAttachment(id: string, root = this.root()!) {
    const row = this.file(id);
    if (!row?.work_id || !row.hash || parseInfo(row).duplicateOf) return;
    const existing = row.attachment_id ? this.attachmentOrNull(row.attachment_id) : null;
    const attachment: Attachment = {
      ...existing,
      id: existing?.id || randomUUID(),
      workId: row.work_id,
      name: basename(row.rel_path),
      path: join(root.path, row.rel_path),
      hash: row.hash,
      mode: "linked",
      size: row.size,
      status: "서고 PDF · 원본 위치 유지",
      exists: true,
      shelfFileId: row.id,
    };
    this.db.saveAttachment(attachment);
    if (!existing) this.db.db.prepare("UPDATE shelf_files SET attachment_id=? WHERE id=?").run(attachment.id, id);
  }
  /** Point a file (and its attachment) at another work; drop the old work if nothing else uses it. */
  moveFile(id: string, workId: string) {
    const row = this.file(id);
    if (!row) return;
    const old = row.work_id;
    this.db.db.prepare("UPDATE shelf_files SET work_id=? WHERE id=?").run(workId, id);
    const a = row.attachment_id ? this.attachmentOrNull(row.attachment_id) : null;
    if (a) this.db.saveAttachment({ ...a, workId });
    this.ftsRefresh(workId);
    if (old && old !== workId) this.dropWorkIfOrphan(old);
  }
  /** Remove a provisional shelf work that nothing in any project, run or chat references. */
  dropWorkIfOrphan(id: string) {
    const used = this.db.db.prepare(
      "SELECT 1 FROM project_works WHERE work_id=? UNION ALL SELECT 1 FROM candidates WHERE work_id=? UNION ALL SELECT 1 FROM collection_works WHERE work_id=? UNION ALL SELECT 1 FROM shelf_files WHERE work_id=? UNION ALL SELECT 1 FROM chat_threads WHERE work_id=? UNION ALL SELECT 1 FROM runs WHERE instr(data,?)>0 UNION ALL SELECT 1 FROM seed_profiles WHERE instr(data,?)>0 LIMIT 1",
    ).get(id, id, id, id, id, id, id);
    if (used) this.ftsRefresh(id);
    else this.purgeWorks([id]);
  }
  /**
   * dropWorkIfOrphan for thousands of works (a shelf moved elsewhere): runs and
   * seed profiles are read once for every id they mention, instead of once per work.
   */
  private dropOrphans(ids: Set<string>) {
    if (!ids.size) return;
    const list = JSON.stringify([...ids]);
    const used = new Set<string>();
    for (const table of ["project_works", "candidates", "collection_works", "shelf_files", "chat_threads"])
      for (const r of this.db.db.prepare(`SELECT DISTINCT work_id FROM ${table} WHERE work_id IN (SELECT value FROM json_each(?))`).all(list) as { work_id: string }[])
        used.add(r.work_id);
    const collect = (value: unknown) => {
      if (typeof value === "string") used.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object")
        for (const [key, inner] of Object.entries(value)) {
          used.add(key);
          collect(inner);
        }
    };
    for (const table of ["runs", "seed_profiles"])
      for (const { data } of this.db.db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]) collect(JSON.parse(data));
    for (const id of ids) if (used.has(id)) this.ftsRefresh(id);
    this.purgeWorks([...ids].filter((id) => !used.has(id)));
  }
  /** Delete works with their identifiers, snapshots, attachments, embeddings, citations and FTS rows, one statement per table. */
  private purgeWorks(ids: string[]) {
    if (!ids.length) return;
    const list = JSON.stringify(ids), each = "(SELECT value FROM json_each(?))";
    for (const table of ["identifiers", "metadata_snapshots", "attachments", "work_embeddings"])
      this.db.db.prepare(`DELETE FROM ${table} WHERE work_id IN ${each}`).run(list);
    this.db.db.prepare(`DELETE FROM citations WHERE citing_id IN ${each}`).run(list);
    this.db.db.prepare(`DELETE FROM shelf_fts WHERE rowid IN (SELECT rowid FROM works WHERE id IN ${each})`).run(list);
    this.db.db.prepare(`UPDATE import_items SET work_id=NULL WHERE work_id IN ${each}`).run(list);
    this.db.db.prepare(`DELETE FROM works WHERE id IN ${each}`).run(list);
    for (const id of ids) this.vectors.remove(id);
  }
  /** Save index-made metadata without recording it as a user edit. */
  private writeWork(work: Work) {
    this.db.db.prepare("UPDATE works SET data=? WHERE id=?").run(JSON.stringify(work), work.id);
    this.db.touch();
    this.ftsRefresh(work.id);
  }
  /** FTS rows share the works rowid, so updates never scan the unindexed work_id column. */
  ftsRefresh(workId: string) {
    const row = this.db.db.prepare("SELECT rowid,data FROM works WHERE id=?").get(workId) as { rowid: number; data: string } | undefined;
    if (!row) return;
    this.db.db.prepare("DELETE FROM shelf_fts WHERE rowid=?").run(row.rowid);
    if (!this.db.db.prepare("SELECT 1 FROM shelf_files WHERE work_id=? LIMIT 1").get(workId)) return;
    const w = JSON.parse(row.data) as Work;
    this.db.db.prepare("INSERT INTO shelf_fts(rowid,work_id,title,authors,abstract,venue) VALUES(?,?,?,?,?,?)")
      .run(row.rowid, workId, w.title, w.authors.join("; "), w.abstract || "", w.venue || "");
  }
  /** Rebuild after bulk table rewrites (undo merge), which renumber works rowids. */
  ftsRebuild() {
    this.db.transaction(() => {
      this.db.db.prepare("DELETE FROM shelf_fts").run();
      for (const { work_id } of this.db.db.prepare("SELECT DISTINCT work_id FROM shelf_files WHERE work_id IS NOT NULL").all() as { work_id: string }[])
        this.ftsRefresh(work_id);
    });
    this.revision++;
  }

  /** Manual decisions from the review screen: choose a candidate or keep the filename record. */
  linkFile(fileId: string, workId: string) {
    this.db.transaction(() => {
      const row = this.file(fileId);
      if (!row) throw new AppError("NOT_FOUND", "서고 파일을 찾을 수 없습니다.");
      this.db.get(workId);
      this.moveFile(fileId, workId);
      this.db.db.prepare("UPDATE shelf_files SET stage='resolved',status='ok',info=? WHERE id=?")
        .run(JSON.stringify({ ...parseInfo(this.file(fileId)!), candidates: undefined, resolution: { method: "manual", at: now() } }), fileId);
      this.ensureAttachment(fileId);
    });
    this.revision++;
  }
  keepProvisional(fileId: string) {
    const row = this.file(fileId);
    if (!row) throw new AppError("NOT_FOUND", "서고 파일을 찾을 수 없습니다.");
    this.db.db.prepare("UPDATE shelf_files SET stage='resolved',status='ok',info=? WHERE id=?")
      .run(JSON.stringify({ ...parseInfo(row), candidates: undefined, resolution: { method: "manual", note: "파일명 서지 유지", at: now() } }), fileId);
    this.revision++;
  }
  /** Accept a reviewed OpenAlex candidate, or look up a DOI the user typed. */
  async resolveManually(fileId: string, identifier: string, signal = AbortSignal.timeout(30000)) {
    const row = this.file(fileId);
    if (!row?.work_id) throw new AppError("NOT_FOUND", "서고 파일을 찾을 수 없습니다.");
    const page = await this.oa.lookup(identifier, signal, () => this.db.usage("openalex", "shelf"));
    const work = page.works[0];
    await this.resolver.abstracts(work.abstract ? [] : [work], signal);
    this.applyResolution(fileId, { kind: "accept", work, method: "title", similarity: 1 });
    this.setInfo(fileId, { resolution: { method: "manual", doi: work.doi || undefined, at: now() } });
    this.ensureAttachment(fileId);
    this.revision++;
    void this.embed(AbortSignal.timeout(60000), [this.file(fileId)!.work_id!]).catch(() => {});
  }

  // ---- moves the app makes itself (수신함 정리) ----
  /** Run `fn` with indexing stopped so a walk never races the app's own moves, then rescan. */
  async hold<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held) throw new AppError("BUSY", "서고 파일을 옮기는 중입니다. 끝난 뒤 다시 시도하세요.");
    this.held = true;
    try {
      this.control?.abort();
      await this.running;
      return await fn();
    } finally {
      this.held = false;
      this.revision++;
      this.emit({ type: "changed" });
      void this.scan("moved");
    }
  }
  /** Record a move made by the app: the row keeps its work, embedding and attachments at the new path. */
  relocate(id: string, relPath: string, mtime: number) {
    const root = this.root();
    const row = this.file(id);
    if (!root || !row) return;
    const folder = parentRel(relPath) ?? "";
    this.db.transaction(() => {
      for (let rel: string | null = folder; rel !== null; rel = parentRel(rel))
        this.db.db.prepare("INSERT INTO shelf_folders VALUES(?,?,?,?,?,1) ON CONFLICT(root_id,rel_path) DO UPDATE SET present=1")
          .run(folderId(root.id, rel), root.id, rel, parentRel(rel) === null ? null : folderId(root.id, parentRel(rel)!), rel ? basename(rel) : root.name);
      // A rename keeps the bytes: carry the hash stamp over so the next scan does not hash and extract again.
      const hashedMtime = row.hashed_mtime !== null && row.hashed_mtime === row.mtime ? mtime : row.hashed_mtime;
      this.db.db.prepare("UPDATE shelf_files SET rel_path=?,folder_id=?,mtime=?,hashed_mtime=?,seen_at=?,missing_since=NULL WHERE id=?")
        .run(relPath, folderId(root.id, folder), mtime, hashedMtime, now(), id);
      this.syncAttachmentPath(id, root);
    });
    this.revision++;
  }
  /**
   * A file the app moved into an excluded folder (e.g. `_duplicated`) leaves the index.
   * Its own shelf attachment goes; project links to it keep working at the new path.
   */
  release(id: string, path: string) {
    this.db.transaction(() => {
      const row = this.file(id);
      if (!row) return;
      for (const r of this.db.db.prepare("SELECT data FROM attachments WHERE id=? OR json_extract(data,'$.shelfFileId')=?").all(row.attachment_id || "", id) as { data: string }[]) {
        const a = JSON.parse(r.data) as Attachment;
        if (a.id === row.attachment_id) this.db.db.prepare("DELETE FROM attachments WHERE id=?").run(a.id);
        else this.db.saveAttachment({ ...a, path, name: basename(path), shelfFileId: undefined });
      }
      this.db.db.prepare("DELETE FROM shelf_files WHERE id=?").run(id);
      if (row.work_id) this.dropWorkIfOrphan(row.work_id);
    });
    this.revision++;
  }

  // ---- permanent deletion ----
  /** The current root's files of these works, missing ones included. */
  filesOf(workIds: string[]): FileRow[] {
    const root = this.root();
    if (!root || !workIds.length) return [];
    return this.db.db.prepare("SELECT * FROM shelf_files WHERE root_id=? AND work_id IN (SELECT value FROM json_each(?)) ORDER BY rel_path")
      .all(root.id, JSON.stringify(workIds)) as FileRow[];
  }
  /** Delete these PDFs from disk; run inside `hold`. A file that is already gone counts as deleted. */
  async unlinkFiles(rows: FileRow[]) {
    const root = this.root();
    if (!root) throw new AppError("SHELF_CONFIG", "서고를 먼저 연결하세요.");
    const deleted: FileRow[] = [], failed: { row: FileRow; reason: string }[] = [];
    for (const row of rows) {
      const path = join(root.path, row.rel_path);
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : error);
      if (info instanceof Error) failed.push({ row, reason: `파일을 확인하지 못했습니다 (${(info as NodeJS.ErrnoException).code || "unknown"}).` });
      else if (info && !info.isFile()) failed.push({ row, reason: "PDF 파일이 아닙니다." });
      else if (!info) deleted.push(row);
      else await unlink(path).then(
        () => deleted.push(row),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? deleted.push(row) : failed.push({ row, reason: `지우지 못했습니다 (${error.code || "unknown"}).` }),
      );
    }
    return { deleted, failed };
  }
  /** Take deleted files out of the index with every attachment made from them; works nothing else uses go too. */
  drop(fileIds: string[]) {
    if (!fileIds.length) return;
    this.db.transaction(() => {
      const works = new Set<string>();
      for (const id of fileIds) {
        const row = this.file(id);
        if (!row) continue;
        this.db.db.prepare("DELETE FROM attachments WHERE id=? OR json_extract(data,'$.shelfFileId')=?").run(row.attachment_id || "", id);
        this.db.db.prepare("DELETE FROM shelf_files WHERE id=?").run(id);
        if (row.work_id) works.add(row.work_id);
      }
      for (const work of works) this.dropWorkIfOrphan(work);
      this.db.touch();
    });
    this.revision++;
  }

  // ---- embeddings ----
  private async ensureModel(): Promise<string | null> {
    const config = this.config();
    if (!config) return null;
    if (this.modelKey && !this.embeddingPaused) return this.modelKey;
    const status = await this.ollama.status(config.model);
    if (!status.running) {
      this.embeddingPaused = "Ollama 꺼짐 · 임베딩 대기";
      return null;
    }
    if (!status.modelInstalled || !status.modelKey) {
      this.embeddingPaused = `${config.model} 모델 없음 · 설정에서 받기`;
      return null;
    }
    this.embeddingPaused = "";
    this.modelKey = status.modelKey;
    this.db.pref("shelf:modelKey", status.modelKey);
    return status.modelKey;
  }
  /** Embed shelf works whose model, prompt or input text changed. Ollama being off only skips this step. */
  async embed(signal: AbortSignal, workIds?: string[]) {
    const config = this.config();
    const model = await this.ensureModel();
    if (!config || !model) return;
    this.vectors.ensure(model);
    const filter = workIds ? "AND f.work_id IN (SELECT value FROM json_each(?))" : "";
    const rows = this.db.db.prepare(
      `SELECT f.work_id,w.data,f.info FROM shelf_files f JOIN works w ON w.id=f.work_id
       WHERE f.status NOT IN ('auxiliary','missing','failed') AND f.stage IN ('extracted','resolved') AND json_extract(f.info,'$.duplicateOf') IS NULL ${filter}
       ORDER BY f.rel_path`,
    ).all(...(workIds ? [JSON.stringify(workIds)] : [])) as { work_id: string; data: string; info: string }[];
    const stored = new Map(
      (this.db.db.prepare(`SELECT work_id,prompt,text_hash FROM work_embeddings WHERE model=? ${workIds ? "AND work_id IN (SELECT value FROM json_each(?))" : ""}`)
        .all(model, ...(workIds ? [JSON.stringify(workIds)] : [])) as { work_id: string; prompt: string; text_hash: string }[])
        .map((r) => [r.work_id, r]),
    );
    const todo: { workId: string; basis: EmbedBasis; input: string; textHash: string }[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.work_id)) continue;
      seen.add(row.work_id);
      const source = embedInput(JSON.parse(row.data), parseInfo(row));
      const input = EMBED_PROMPTS.document(source.title, source.text);
      const textHash = sha256(input);
      const old = stored.get(row.work_id);
      if (old && old.prompt === EMBED_PROMPTS.version && old.text_hash === textHash) continue;
      todo.push({ workId: row.work_id, basis: source.basis, input, textHash });
    }
    for (let i = 0; i < todo.length; i += 32) {
      signal.throwIfAborted();
      const batch = todo.slice(i, i + 32);
      let vectors: Float32Array[];
      try {
        vectors = await this.ollama.embed(config.model, batch.map((t) => t.input), signal);
      } catch (error) {
        signal.throwIfAborted();
        this.embeddingPaused = error instanceof AppError && error.code === "OLLAMA_MODEL" ? `${config.model} 모델 없음 · 설정에서 받기` : "Ollama 임베딩 실패 · 다음 스캔에서 재시도";
        this.modelKey = null;
        return;
      }
      this.db.transaction(() => {
        batch.forEach((t, n) => {
          if (this.exists(t.workId)) this.vectors.save(t.workId, model, EMBED_PROMPTS.version, t.basis, t.textHash, vectors[n]);
        });
      });
      if (!workIds) this.setJob({ state: "indexing", message: `임베딩 ${Math.min(i + 32, todo.length).toLocaleString()}/${todo.length.toLocaleString()}편`, done: Math.min(i + 32, todo.length), total: todo.length }, true);
    }
  }
  /** Vector for any text (queries, papers outside the shelf), cached locally (LRU 5,000). */
  async embedText(kind: "query" | "document", title: string, text: string, signal: AbortSignal): Promise<Float32Array | null> {
    const config = this.config();
    const model = await this.ensureModel();
    if (!config || !model) return null;
    const input = kind === "query" ? EMBED_PROMPTS.query(text) : EMBED_PROMPTS.document(title, text);
    const key = sha256(`${model}\u0000${EMBED_PROMPTS.version}\u0000${input}`);
    const cached = this.db.db.prepare("SELECT vector FROM embedding_cache WHERE key=?").get(key) as { vector: Uint8Array } | undefined;
    if (cached) {
      this.db.db.prepare("UPDATE embedding_cache SET used_at=? WHERE key=?").run(now(), key);
      const copy = cached.vector.slice();
      return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
    }
    let vector: Float32Array;
    try {
      [vector] = await this.ollama.embed(config.model, [input], signal);
    } catch {
      signal.throwIfAborted();
      this.modelKey = null;
      return null;
    }
    this.db.db.prepare("INSERT OR REPLACE INTO embedding_cache VALUES(?,?,?,?)").run(key, model, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), now());
    if (Math.random() < 0.05)
      this.db.db.prepare("DELETE FROM embedding_cache WHERE key IN (SELECT key FROM embedding_cache ORDER BY used_at DESC LIMIT -1 OFFSET 5000)").run();
    return vector;
  }

  // ---- summaries ----
  private setJob(job: Omit<ShelfJob, "updatedAt">, throttle = false) {
    this.job = {
      ...job,
      ...(this.resolverPausedUntil > Date.now() ? { resolverPausedUntil: new Date(this.resolverPausedUntil).toISOString() } : {}),
      ...(this.embeddingPaused ? { embeddingPaused: this.embeddingPaused } : {}),
      updatedAt: now(),
    };
    if (throttle && Date.now() - this.lastProgress < 1000) return;
    this.lastProgress = Date.now();
    this.emit({ type: "shelf" });
  }
  counts(rootId?: string): ShelfIndexCounts {
    const where = rootId ? "WHERE root_id=?" : "";
    const args = rootId ? [rootId] : [];
    const stages = { found: 0, hashed: 0, extracted: 0, resolved: 0 } as Record<ShelfStage, number>;
    const statuses = { ok: 0, review: 0, provisional: 0, auxiliary: 0, failed: 0, missing: 0 } as Record<ShelfStatus, number>;
    let files = 0;
    for (const r of this.db.db.prepare(`SELECT stage,status,count(*) AS n FROM shelf_files ${where} GROUP BY stage,status`).all(...args) as { stage: ShelfStage; status: ShelfStatus; n: number }[]) {
      files += r.n;
      stages[r.stage] = (stages[r.stage] || 0) + r.n;
      // Unfinished files carry a provisional status; count them as waiting, not as filename records.
      if (r.status !== "provisional" || r.stage === "resolved") statuses[r.status] = (statuses[r.status] || 0) + r.n;
    }
    const works = (this.db.db.prepare(`SELECT count(DISTINCT work_id) AS n FROM shelf_files ${where ? where + " AND" : "WHERE"} status!='missing' AND work_id IS NOT NULL`).get(...args) as { n: number }).n;
    const embeddable = (this.db.db.prepare(`SELECT count(DISTINCT work_id) AS n FROM shelf_files ${where ? where + " AND" : "WHERE"} status NOT IN ('auxiliary','missing','failed') AND work_id IS NOT NULL AND stage IN ('extracted','resolved')`).get(...args) as { n: number }).n;
    const embedded = this.modelKey
      ? (this.db.db.prepare("SELECT count(*) AS n FROM work_embeddings WHERE model=? AND prompt=? AND work_id IN (SELECT work_id FROM shelf_files WHERE status!='missing')").get(this.modelKey, EMBED_PROMPTS.version) as { n: number }).n
      : 0;
    return { files, works, stages, statuses, embedded, embeddable };
  }
  /**
   * Sidebar counts. With a project, papers in its trash are left out, as the
   * shelf lists leave them out; the index counts (`counts`) stay project-free.
   */
  summary(projectId?: string): ShelfSummary {
    const root = this.root();
    const counts = this.counts(root?.id);
    if (!root) return { configured: false, root: null, online: false, folders: [], inbox: 0, uncategorized: null, review: 0, total: 0, counts, job: this.job };
    const trashed = projectId ? " AND work_id NOT IN (SELECT work_id FROM project_works WHERE project_id=? AND json_extract(state,'$.screening')='trash')" : "";
    const scope = projectId ? [root.id, projectId] : [root.id];
    const folders = this.db.db.prepare("SELECT id,parent_id AS parentId,name,rel_path AS relPath FROM shelf_folders WHERE root_id=? AND present=1 ORDER BY rel_path").all(root.id) as { id: string; parentId: string | null; name: string; relPath: string }[];
    const direct = new Map(
      (this.db.db.prepare(`SELECT folder_id,count(DISTINCT work_id) AS n FROM shelf_files WHERE root_id=? AND status!='missing' AND work_id IS NOT NULL AND json_extract(info,'$.duplicateOf') IS NULL${trashed} GROUP BY folder_id`).all(...scope) as { folder_id: string; n: number }[])
        .map((r) => [r.folder_id, r.n]),
    );
    const byId = new Map(folders.map((f) => [f.id, { ...f, count: 0 }]));
    for (const f of folders) {
      let current: string | null = f.id;
      const n = direct.get(f.id) || 0;
      while (current && byId.has(current)) {
        byId.get(current)!.count += n;
        current = byId.get(current)!.parentId;
      }
    }
    const inbox = folders.filter((f) => isInboxFolder(f.relPath)).reduce((sum, f) => sum + (direct.get(f.id) || 0), 0);
    const parked = folders.filter((f) => isUncategorizedFolder(f.relPath)).reduce((sum, f) => sum + (direct.get(f.id) || 0), 0);
    const parkedId = folders.find((f) => f.relPath === SHELF_UNCATEGORIZED)?.id;
    const review = (this.db.db.prepare(`SELECT count(DISTINCT work_id) AS n FROM shelf_files WHERE root_id=? AND stage='resolved' AND status IN ('review','provisional') AND work_id IS NOT NULL${trashed}`).get(...scope) as { n: number }).n;
    const total = projectId
      ? (this.db.db.prepare(`SELECT count(DISTINCT work_id) AS n FROM shelf_files WHERE root_id=? AND status!='missing' AND work_id IS NOT NULL${trashed}`).get(...scope) as { n: number }).n
      : counts.works;
    return {
      configured: true,
      root: { id: root.id, path: root.path, name: root.name, lastScanAt: root.last_scan_at },
      online: this.online,
      folders: [...byId.values()].filter((f) => !isInboxFolder(f.relPath) && !isUncategorizedFolder(f.relPath)),
      inbox,
      uncategorized: parkedId && parked ? { id: parkedId, count: parked } : null,
      review,
      total,
      counts,
      job: this.job,
    };
  }
  /** Files whose lookup finished without verified metadata; files still waiting for OpenAlex are not counted. */
  reviewCount(rootId: string) {
    return (this.db.db.prepare("SELECT count(DISTINCT work_id) AS n FROM shelf_files WHERE root_id=? AND stage='resolved' AND status IN ('review','provisional') AND work_id IS NOT NULL").get(rootId) as { n: number }).n;
  }
  async status(): Promise<ShelfStatusResult> {
    const config = this.config();
    const ollama = await this.ollama.status(config?.model || DEFAULT_EMBED_MODEL);
    if (ollama.modelKey && ollama.modelKey !== this.modelKey) {
      this.modelKey = ollama.modelKey;
      this.db.pref("shelf:modelKey", ollama.modelKey);
    }
    const root = this.root();
    const failures = root
      ? (this.db.db.prepare("SELECT id,rel_path,json_extract(info,'$.error') AS error FROM shelf_files WHERE root_id=? AND status='failed' ORDER BY rel_path LIMIT 100").all(root.id) as { id: string; rel_path: string; error: string | null }[])
          .map((r) => ({ fileId: r.id, path: r.rel_path, reason: r.error || "처리 실패" }))
      : [];
    return { summary: this.summary(), managed: this.managedCount(), config, ollama, failures };
  }
  /** Absolute path for Finder; refuses files outside the configured shelf. */
  filePath(fileId: string) {
    const row = this.file(fileId);
    const root = this.root();
    if (!row || !root || row.root_id !== root.id) throw new AppError("NOT_FOUND", "서고 파일을 찾을 수 없습니다.");
    return join(root.path, row.rel_path);
  }
}
