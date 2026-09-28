import { z } from "zod";
import { fork } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  stat,
  lstat,
  readdir,
  copyFile,
  rename,
  rm,
  mkdir,
  open,
} from "node:fs/promises";
import { join, basename, dirname, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  DEFAULT_FILTERS,
  now,
  type Run,
  type AppEvent,
} from "../../shared/types";
import { blankWork, normalizeDoi, titleSimilarity } from "../../shared/domain";
import type { Library } from "../db/database";
import type { OpenAlex } from "../providers/openalex";
export async function hashFile(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifyPdf(path: string) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024);
    await file.read(buffer, 0, 1024, 0);
    if (!buffer.includes(Buffer.from("%PDF-")))
      throw new AppError("NOT_PDF", "PDF 형식을 확인할 수 없습니다.");
  } finally {
    await file.close();
  }
}
async function scan(paths: string[]): Promise<string[]> {
  const output: string[] = [];
  const visit = async (path: string) => {
    const s = await lstat(path);
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      for (const e of await readdir(path)) await visit(join(path, e));
    } else if (extname(path).toLowerCase() === ".pdf") output.push(path);
    if (output.length > 10000)
      throw new AppError(
        "IMPORT_LIMIT",
        "한 번에 10,000개 이하의 PDF를 가져오세요.",
      );
  };
  for (const p of paths) await visit(p);
  return [...new Set(output)];
}
const extractedSchema = z.object({
  title: z.string(), authors: z.string(), dois: z.array(z.string()),
  pages: z.number().nullable(), text: z.string(), status: z.string(),
});
type Extracted = z.infer<typeof extractedSchema>;
function extract(
  path: string,
  workerPath: string,
  signal: AbortSignal,
): Promise<Extracted> {
  return new Promise((resolve, reject) => {
    const worker = fork(workerPath, [path], {
      execPath: process.execPath,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    let settled = false;
    const done = (result?: Extracted, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.kill();
      if (error) reject(error);
      else resolve(result!);
    };
    const fallback = () =>
      done({
        title: "",
        authors: "",
        dois: [],
        pages: null,
        text: "",
        status: "추출 제한 또는 실패 · 수동 확인 필요",
      });
    const timer = setTimeout(fallback, 15000);
    const abort = () =>
      done(undefined, new AppError("CANCELLED", "취소되었습니다."));
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (data) => {
      const parsed = extractedSchema.safeParse(data);
      if (parsed.success) done(parsed.data); else fallback();
    });
    worker.once("error", fallback);
    worker.once("exit", () => {
      if (!settled) fallback();
    });
  });
}
export class PdfImports {
  active = new Map<string, AbortController>();
  constructor(
    private db: Library,
    private oa: OpenAlex,
    private workerPath: string,
    private emit: (event: AppEvent) => void,
  ) {}
  async start(
    projectId: string,
    paths: string[],
    options: Omit<NonNullable<Run["import"]>, "paths" | "index">,
  ): Promise<Run> {
    if (this.active.size)
      throw new AppError("BUSY", "PDF 가져오기가 진행 중입니다.");
    const files = await scan(paths);
    if (!files.length)
      throw new AppError("NO_PDF", "PDF 파일을 찾지 못했습니다.");
    const run: Run = {
      id: randomUUID(),
      projectId,
      mode: "search",
      query: `PDF 가져오기 (${files.length}개)`,
      seedProfileId: null,
      inputIds: [],
      filters: { ...DEFAULT_FILTERS },
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
      calls: 0,
      maxCalls: 40,
      maxCandidates: files.length,
      total: files.length,
      count: 0,
      message: "PDF 가져오기 준비",
      tasks: [],
      rankingVersion: "pdf-v1",
      import: { paths: files, index: 0, ...options },
    };
    this.db.saveRun(run);
    void this.execute(run.id);
    return run;
  }
  async execute(id: string) {
    const control = new AbortController();
    this.active.set(id, control);
    const signal = control.signal;
    const run = this.db.run(id);
    run.status = "running";
    try {
      const job = run.import!;
      for (let i = job.index; i < job.paths.length; i++) {
        signal.throwIfAborted();
        const path = job.paths[i];
        run.message = `PDF ${i + 1}/${job.paths.length} · ${basename(path)}`;
        this.db.saveRun(run);
        this.emit({ type: "progress", runId: id });
        try {
          const size = (await stat(path)).size;
          await verifyPdf(path);
          const hash = await hashFile(path, signal);
          const existing = this.db.db
            .prepare(
              "SELECT data FROM attachments WHERE json_extract(data,'$.hash')=? LIMIT 1",
            )
            .get(hash) as { data: string } | undefined;
          let work = job.workId
            ? this.db.get(job.workId)
            : existing
              ? this.db.get(JSON.parse(existing.data).workId)
              : null;
          let status = "연결됨";
          if (!work) {
            const result =
              size > 100 * 1024 * 1024
                ? {
                    title: "",
                    authors: "",
                    dois: [],
                    pages: null,
                    text: "",
                    status: "100MB 초과 · 추출 생략",
                  }
                : await extract(path, this.workerPath, signal);
            status = result.status;
            if (
              result.dois.length === 1 &&
              result.title.length > 12 &&
              run.calls < 40
            ) {
              try {
                const page = await this.oa.lookup(
                  result.dois[0],
                  signal,
                  () => {
                    signal.throwIfAborted();
                    run.calls++;
                    this.db.usage("openalex", id);
                    this.db.saveRun(run);
                  },
                );
                const candidate = page.works[0];
                if (titleSimilarity(result.title, candidate.title) >= 0.35) {
                  work = this.db.upsert(candidate).work;
                  status = "DOI와 제목 일치";
                }
              } catch (error) {
                if (signal.aborted) throw error;
              }
            }
            if (!work) {
              const provisional = blankWork({
                title: result.title || basename(path, ".pdf"),
                authors: result.authors ? [result.authors] : [],
                source: "pdf",
                raw: {
                  filename: basename(path),
                  doiCandidates: result.dois.map(normalizeDoi),
                  extractionStatus: result.status,
                },
                citekey: "",
              });
              work = this.db.upsert(provisional).work;
              status = "서지 확인 필요 · " + result.status;
            }
          }
          signal.throwIfAborted();
          let attachmentPath = path;
          if (job.mode === "managed") {
            const target = join(this.db.root, "attachments", hash + ".pdf");
            const temporary = target + "." + randomUUID() + ".staging";
            try {
              await mkdir(dirname(target), { recursive: true });
              try {
                await stat(target);
              } catch {
                await copyFile(path, temporary);
                if ((await hashFile(temporary, signal)) !== hash)
                  throw new AppError(
                    "COPY_HASH",
                    "복사한 PDF의 해시가 다릅니다.",
                  );
                signal.throwIfAborted();
                await rename(temporary, target);
              }
            } finally {
              await rm(temporary, { force: true });
            }
            attachmentPath = target;
          }
          this.db.transaction(() => {
            this.db.ensureMembership(run.projectId, work!.id);
            if (
              job.mode !== "metadata" &&
              !this.db.attachments(work!.id).some((a) => a.hash === hash)
            )
              this.db.saveAttachment({
                id: randomUUID(),
                workId: work!.id,
                name: basename(path),
                hash,
                path: attachmentPath,
                mode: job.mode,
                size,
                status,
                exists: true,
              });
            let collectionId = job.collectionId;
            if (job.mapFolders) {
              const name = basename(dirname(path));
              collectionId =
                this.db.collections(run.projectId).find((c) => c.name === name)
                  ?.id || this.db.createCollection(run.projectId, name).id;
            }
            if (collectionId)
              this.db.db
                .prepare("INSERT OR IGNORE INTO collection_works VALUES(?,?)")
                .run(collectionId, work!.id);
            this.db.candidate(run, work!, {
              origins: ["로컬 PDF"],
              seedIds: [],
              sharedIds: [],
              denominator: 0,
              relation: "import",
              score: null,
              reasons: [status],
              hidden: [],
              deferred: status.includes("확인 필요"),
              scope: "첫 페이지·메타데이터; 원본 유지",
            });
            this.db.db
              .prepare("INSERT INTO import_items VALUES(?,?,?,?,?,?)")
              .run(
                randomUUID(),
                id,
                basename(path),
                "completed",
                status,
                work!.id,
              );
            run.count++;
            job.index = i + 1;
            this.db.saveRun(run);
          });
        } catch (error) {
          if (signal.aborted) throw error;
          this.db.db
            .prepare("INSERT INTO import_items VALUES(?,?,?,?,?,?)")
            .run(
              randomUUID(),
              id,
              basename(path),
              "failed",
              error instanceof AppError
                ? error.message
                : `파일 접근·복사·추출 실패 (${(error as NodeJS.ErrnoException)?.code || (error as Error)?.name || "unknown"})`,
              null,
            );
          job.index = i + 1;
          this.db.saveRun(run);
        }
        this.emit({ type: "changed", runId: id });
      }
      run.status = "completed";
      const failures = (
        this.db.db
          .prepare(
            "SELECT count(*) AS n FROM import_items WHERE run_id=? AND status='failed'",
          )
          .get(id) as { n: number }
      ).n;
      run.message = `${run.count}개 가져옴${failures ? ` · 실패 ${failures}개 (재개로 실패 파일 재시도)` : ""}`;
    } catch {
      run.status = signal.aborted ? "cancelled" : "failed";
      run.message = "PDF 가져오기 중단 · 처리된 파일은 보존됩니다.";
    } finally {
      this.db.saveRun(run);
      this.active.delete(id);
      this.emit({ type: "changed", runId: id });
    }
  }
  control(id: string, action: "cancel" | "resume" | "more") {
    if (action === "cancel") {
      this.active.get(id)?.abort();
      return;
    }
    if (this.active.size)
      throw new AppError("BUSY", "PDF 가져오기가 진행 중입니다.");
    const run = this.db.run(id);
    if (run.import!.index >= run.import!.paths.length) {
      const names = (
        this.db.db
          .prepare(
            "SELECT name FROM import_items WHERE run_id=? AND status='failed'",
          )
          .all(id) as { name: string }[]
      ).map((x) => x.name);
      run.import!.paths = run.import!.paths.filter((p) =>
        names.includes(basename(p)),
      );
      run.import!.index = 0;
      this.db.db
        .prepare("DELETE FROM import_items WHERE run_id=? AND status='failed'")
        .run(id);
    }
    run.status = "queued";
    this.db.saveRun(run);
    void this.execute(id);
  }
}
