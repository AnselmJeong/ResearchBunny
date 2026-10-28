import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type Database from "../db/sqlite";
import { extractPdfLines } from "../interchange/pdf";
import type { OllamaLocal } from "../providers/ollama-local";
import { now } from "../../shared/types";
import { EMBED_PROMPTS } from "../../shared/shelf";
import type { PassageJob, PassageStatus } from "../../shared/passages";
import { CHUNKER_VERSION, split } from "./chunker";
import type { PassageStore } from "./store";

/** Passages per embedding request; larger batches were no faster on Apple silicon. */
const BATCH = 32;
/** PDFs read at once: extraction outpaces embedding, so two keep the queue full without loading the NAS. */
const EXTRACTORS = 2;
/** A lock older than this belongs to a process that is gone. */
const LOCK_MS = 2 * 60 * 1000;

export interface PassageSource {
  hash: string;
  path: string;
  root: string;
  title: string;
  size: number;
  mtime: number;
}
export const passageInput = (title: string, section: string, text: string) => EMBED_PROMPTS.document(title, section ? `${section}. ${text}` : text);
/** Vectors are comparable only within one model digest and one prompt format. */
export const vectorModel = (modelKey: string) => `${modelKey}#${EMBED_PROMPTS.version}`;

/** Waits `ms`, or until the function handed to `onWake` is called. */
const sleep = (ms: number, signal: AbortSignal, onWake: (wake: () => void) => void) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", abort, { once: true });
    onWake(done);
  });

/**
 * Splits shelf PDFs into passages and embeds them, newest work first in the
 * sense that every pass only handles what changed: PDFs not yet split (or split
 * by an older chunker), passages without a vector from the current model, and
 * PDFs that left the shelf. It reads the library but never writes to it, so the
 * same code runs inside the app and from `scripts/passages.ts`.
 */
export class PassageIndexer {
  job: PassageJob = { state: "idle", message: "", docs: { done: 0, total: 0 }, passages: { done: 0, total: 0 }, updatedAt: now() };
  private control: AbortController | null = null;
  private running: Promise<void> | null = null;
  private owner = randomUUID();
  private lastReport = 0;
  private rate: { at: number; done: number }[] = [];

  constructor(
    private lib: Database,
    private store: PassageStore,
    private workerPath: string,
    private ollama: OllamaLocal,
    private options: {
      /** Ollama model name from the shelf settings; null when no shelf is configured. */
      model: () => string | null;
      onJob?: (job: PassageJob) => void;
      extractors?: number;
      /** Only the first PDFs, for trying a pass on a real shelf. */
      limit?: number;
    },
  ) {}

  get active() {
    return !!this.running;
  }
  paused() {
    return this.store.meta<boolean>("paused") === true;
  }
  setPaused(paused: boolean) {
    this.store.setMeta("paused", paused);
    if (paused) {
      this.control?.abort();
      this.report({ state: "paused", message: "본문 색인 일시정지" }, true);
    }
  }
  stop() {
    this.control?.abort();
  }
  async wait() {
    await this.running;
  }

  /** Shelf PDFs that should have passages: indexed, resolved to a work, not a duplicate copy, and hashed as they are now. */
  sources(): PassageSource[] {
    const rows = this.lib.prepare(
      `SELECT f.hash,r.path AS root,f.rel_path,f.size,f.mtime,f.hashed_size,f.hashed_mtime,json_extract(w.data,'$.title') AS title
       FROM shelf_files f JOIN shelf_roots r ON r.id=f.root_id LEFT JOIN works w ON w.id=f.work_id
       WHERE f.hash IS NOT NULL AND f.work_id IS NOT NULL AND f.status NOT IN ('missing','auxiliary','hidden','failed')
         AND json_extract(f.info,'$.duplicateOf') IS NULL
       ORDER BY f.rel_path`,
    ).all() as { hash: string; root: string; rel_path: string; size: number; mtime: number; hashed_size: number | null; hashed_mtime: number | null; title: string | null }[];
    const seen = new Set<string>();
    const out: PassageSource[] = [];
    for (const r of rows) {
      if (seen.has(r.hash) || r.hashed_size !== r.size || r.hashed_mtime !== r.mtime) continue;
      seen.add(r.hash);
      out.push({ hash: r.hash, path: `${r.root}/${r.rel_path}`, root: r.root, title: r.title || "", size: r.size, mtime: r.mtime });
    }
    return this.options.limit ? out.slice(0, this.options.limit) : out;
  }
  /** Hashes any shelf row still refers to; passages of other PDFs are removed. Missing files keep theirs until the shelf forgets them. */
  private kept(): Set<string> {
    return new Set((this.lib.prepare("SELECT DISTINCT hash FROM shelf_files WHERE hash IS NOT NULL AND status!='hidden'").all() as { hash: string }[]).map((r) => r.hash));
  }

  async status(): Promise<PassageStatus> {
    const name = this.options.model();
    const ollama = name ? await this.ollama.status(name).catch(() => null) : null;
    const model = ollama?.modelKey ? vectorModel(ollama.modelKey) : this.store.meta<string>("model");
    const counts = this.store.counts(model);
    if (!this.running) this.refreshCounts(model);
    return { job: this.job, empty: counts.empty, failed: counts.failed, model };
  }
  private refreshCounts(model: string | null) {
    const sources = this.sources();
    const docs = this.store.docs();
    const done = sources.filter((s) => docs.get(s.hash)?.chunker === CHUNKER_VERSION).length;
    const counts = this.store.counts(model);
    this.job = { ...this.job, docs: { done, total: sources.length }, passages: { done: counts.embedded, total: counts.passages }, updatedAt: now() };
  }

  private report(patch: Partial<PassageJob>, force = false) {
    this.job = { ...this.job, ...patch, updatedAt: now() };
    if (!force && Date.now() - this.lastReport < 1000) return;
    this.lastReport = Date.now();
    this.options.onJob?.(this.job);
  }

  /** One process indexes at a time: the app and a command-line pass share the file. */
  private lock(): boolean {
    return this.store.db.transaction(() => {
      const held = this.store.meta<{ id: string; at: number; pid: number }>("owner");
      if (held && held.id !== this.owner && Date.now() - held.at < LOCK_MS) return false;
      this.store.setMeta("owner", { id: this.owner, at: Date.now(), pid: process.pid });
      return true;
    }).immediate();
  }
  private unlock() {
    try {
      const held = this.store.meta<{ id: string }>("owner");
      if (held?.id === this.owner) this.store.db.prepare("DELETE FROM meta WHERE key='owner'").run();
    } catch {
      // A closed or removed index has no lock left to release; a stale one expires on its own.
    }
  }

  /** Start a pass unless one is running or indexing is paused; resolves when it ends. */
  run(): Promise<void> {
    if (this.running) return this.running;
    if (this.paused()) {
      this.report({ state: "paused", message: "본문 색인 일시정지" }, true);
      return Promise.resolve();
    }
    const name = this.options.model();
    if (!name) return Promise.resolve();
    let locked: boolean;
    try {
      locked = this.lock();
    } catch (error) {
      this.report({ state: "idle", message: `본문 색인 파일을 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}` }, true);
      return Promise.resolve();
    }
    if (!locked) {
      this.report({ state: "waiting", message: "다른 프로세스가 본문을 색인하고 있습니다." }, true);
      return Promise.resolve();
    }
    const control = new AbortController();
    this.control = control;
    const heartbeat = setInterval(() => {
      try {
        this.lock();
      } catch {
        // A busy database skips one beat.
      }
    }, 30000);
    heartbeat.unref?.();
    this.running = this.pass(name, control.signal)
      .catch((error) => {
        if (control.signal.aborted) {
          if (!this.paused()) this.report({ state: "idle", message: "본문 색인을 멈췄습니다. 다음에 이어서 합니다." }, true);
          return;
        }
        this.report({ state: "idle", message: `본문 색인 오류: ${error instanceof Error ? error.message : String(error)}` }, true);
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.unlock();
        this.control = null;
        this.running = null;
      });
    return this.running;
  }

  private async pass(name: string, signal: AbortSignal) {
    const status = await this.ollama.status(name);
    const model = status.modelKey ? vectorModel(status.modelKey) : null;
    if (model) this.store.setMeta("model", model);
    const kept = this.kept();
    this.store.deleteDocs([...this.store.docs().keys()].filter((hash) => !kept.has(hash)));
    const sources = this.sources();
    const docs = this.store.docs();
    const todo = sources.filter((s) => docs.get(s.hash)?.chunker !== CHUNKER_VERSION);
    let done = sources.length - todo.length;
    // Counted as work goes and recounted every minute: counting half a million rows per batch would slow the pass.
    let counts = this.store.counts(model);
    let counted = Date.now();
    const recount = () => {
      if (Date.now() - counted < 60000) return;
      counts = this.store.counts(model);
      counted = Date.now();
    };
    this.rate = [];
    this.report({ state: "running", message: "본문 색인 중", docs: { done, total: sources.length }, passages: { done: counts.embedded, total: counts.passages } }, true);

    let extracting = true;
    let offline = false;
    // The embedder waits for new passages; extraction wakes it as soon as it stores some or ends.
    let wake = () => {};
    const extraction = (async () => {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(this.options.extractors ?? EXTRACTORS, todo.length) }, async () => {
        while (next < todo.length && !offline) {
          signal.throwIfAborted();
          const source = todo[next++];
          const stored = await this.extract(source, signal);
          if (stored === "offline") offline = true;
          else if (stored !== false) {
            done++;
            counts.passages += stored;
            wake();
          }
          recount();
          this.report({ docs: { done, total: sources.length }, passages: { done: counts.embedded, total: counts.passages } });
        }
      }));
    })().finally(() => {
      extracting = false;
      wake();
    });

    const embedding = (async () => {
      if (!model) return status.running ? `${name} 모델 없음` : "Ollama 꺼짐";
      let after = 0;
      while (true) {
        signal.throwIfAborted();
        const batch = this.store.pending(model, after, BATCH);
        if (!batch.length) {
          if (!extracting) return null;
          await sleep(1500, signal, (resume) => {
            wake = resume;
          });
          continue;
        }
        let vectors: Float32Array[];
        try {
          vectors = await this.ollama.embed(name, batch.map((p) => passageInput(p.title, p.section, p.text)), signal);
        } catch (error) {
          signal.throwIfAborted();
          return error instanceof Error ? error.message : "Ollama 임베딩 실패";
        }
        this.store.saveVectors(model, batch.map((p, i) => ({ id: p.id, vector: vectors[i] })));
        after = batch.at(-1)!.id;
        counts.embedded += batch.length;
        recount();
        this.report({ passages: { done: counts.embedded, total: counts.passages }, rate: this.speed(counts.embedded) });
      }
    })();

    const [, problem] = await Promise.all([extraction, embedding]);
    const final = this.store.counts(model);
    const remaining = final.passages - final.embedded;
    this.report({
      state: offline ? "offline" : problem ? "waiting" : "idle",
      message: offline
        ? "서고가 연결되지 않아 본문 색인을 멈췄습니다."
        : problem
          ? `본문 임베딩 대기 · ${problem}`
          : `본문 색인 완료 · ${final.ok.toLocaleString()}편 ${final.passages.toLocaleString()}구절${remaining ? ` · 임베딩 남음 ${remaining.toLocaleString()}` : ""}`,
      docs: { done, total: sources.length },
      passages: { done: final.embedded, total: final.passages },
      rate: undefined,
    }, true);
  }

  /** Passages per second over the last five minutes. */
  private speed(embedded: number) {
    const at = Date.now();
    this.rate.push({ at, done: embedded });
    while (this.rate.length > 2 && at - this.rate[0].at > 5 * 60 * 1000) this.rate.shift();
    const first = this.rate[0];
    return at > first.at ? Math.round(((embedded - first.done) / ((at - first.at) / 1000)) * 10) / 10 : undefined;
  }

  /** Split one PDF into passages and return how many; "offline" when the shelf disappeared, false when the file changed under us. */
  private async extract(source: PassageSource, signal: AbortSignal): Promise<number | false | "offline"> {
    const lines = await extractPdfLines(source.path, this.workerPath, signal);
    if (!lines) {
      // A failure only counts when the file is still there as indexed; an unmounted share is not a broken PDF.
      if (!(await stat(source.root).catch(() => null))) return "offline";
      const info = await stat(source.path).catch(() => null);
      if (!info || info.size !== source.size || Math.trunc(info.mtimeMs) !== source.mtime) return false;
      this.store.saveDoc(source.hash, CHUNKER_VERSION, source.title, { status: "failed", message: "PDF를 읽지 못했습니다(암호화·손상·시간 초과)." });
      return 0;
    }
    const result = split(lines);
    this.store.saveDoc(source.hash, CHUNKER_VERSION, source.title, result);
    return result.chunks.length;
  }
}
