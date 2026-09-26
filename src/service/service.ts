import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import type {
  AppEvent,
  ImportPreview,
  ImportResult,
  Settings,
} from "../shared/types";
import { AppError } from "../shared/types";
import { blankWork, titleSimilarity, safeWebUrl } from "../shared/domain";
import { Library } from "./db/database";
import { OpenAlex } from "./providers/openalex";
import { AIProvider, DEFAULT_AI, type AIConfig } from "./providers/openai";
import { Discovery } from "./discovery/engine";
import { parseBib, exportBib, type BibEntry } from "./interchange/bibtex";
import { PdfImports, hashFile, verifyPdf } from "./interchange/pdf";
import { createBackup, restoreBackup } from "./interchange/backup";
import { mergeWorks, undoMerge } from "./db/merge";
export class Service {
  db: Library;
  oa: OpenAlex;
  ai: AIProvider;
  discovery: Discovery;
  pdf: PdfImports;
  secrets: { openalex?: string; openai?: string; secureStorage?: boolean } = {};
  previews = new Map<string, BibEntry[]>();
  constructor(
    root: string,
    workerPath: string,
    private emit: (event: AppEvent) => void,
  ) {
    this.db = new Library(root);
    this.oa = new OpenAlex(this.db, () => this.secrets.openalex);
    this.ai = new AIProvider(
      this.db,
      () => this.secrets.openai,
      () => ({ ...DEFAULT_AI, ...this.db.pref<AIConfig>("ai") }),
    );
    this.discovery = new Discovery(this.db, this.oa, emit, this.ai);
    this.pdf = new PdfImports(this.db, this.oa, workerPath, emit);
  }
  busy() {
    return this.discovery.active.size > 0 || this.pdf.active.size > 0;
  }
  settings(): Settings {
    return {
      ...DEFAULT_AI,
      ...this.db.pref<AIConfig>("ai"),
      openalexConfigured: !!this.secrets.openalex,
      openaiConfigured: !!this.secrets.openai,
      secureStorage: this.secrets.secureStorage ?? null,
      theme: this.db.pref<Settings["theme"]>("theme") || "system",
      dataPath: this.db.root,
      version: "0.1.0",
      usage: this.db.usageSummary(),
    };
  }
  async call(command: string, args: any): Promise<any> {
    switch (command) {
      case "init":
        this.secrets = args;
        return true;
      case "snapshot": {
        const projectId = args.projectId || this.db.projects()[0].id;
        this.db.project(projectId);
        const history = this.db.seedHistory(projectId);
        return {
          projects: this.db.projects(),
          collections: this.db.collections(projectId),
          seeds: history[0] || null,
          seedHistory: history,
          runs: this.db.runs(projectId),
          counts: this.db.counts(projectId),
          settings: this.settings(),
          ui: this.db.pref("ui:" + projectId) || {},
        };
      }
      case "createProject":
        return this.db.createProject(args.name, args.question);
      case "updateProject":
        this.db.project(args.projectId);
        this.db.db
          .prepare("UPDATE projects SET name=?,question=? WHERE id=?")
          .run(args.name, args.question, args.projectId);
        return;
      case "createCollection":
        return this.db.createCollection(
          args.projectId,
          args.name,
          args.parentId,
        );
      case "collectionMembers": {
        if (
          !this.db
            .collections(args.projectId)
            .some((c) => c.id === args.collectionId)
        )
          throw new AppError("INVALID", "대상 컬렉션을 확인하세요.");
        this.db.transaction(() => {
          for (const id of args.ids) {
            this.db.get(id);
            if (args.remove)
              this.db.db
                .prepare(
                  "DELETE FROM collection_works WHERE collection_id=? AND work_id=?",
                )
                .run(args.collectionId, id);
            else {
              this.db.mutate(args.projectId, [id], { screening: "included" });
              this.db.db
                .prepare("INSERT OR IGNORE INTO collection_works VALUES(?,?)")
                .run(args.collectionId, id);
            }
          }
        });
        return;
      }
      case "list":
        return this.db.list(args);
      case "inspect":
        return this.db.view(args.projectId, args.workId, args.runId);
      case "mutateWorks":
        this.db.mutate(args.projectId, args.ids, args.patch);
        return;
      case "restoreWorks":
        for (const id of args.ids) {
          const state = this.db.state(args.projectId, id);
          this.db.mutate(args.projectId, [id], {
            screening: state.previousScreening || "pending",
          });
        }
        return;
      case "editWork":
        return this.db.edit(args.workId, args.patch);
      case "manualWork": {
        const { work } = this.db.upsert(blankWork(args.metadata));
        this.db.mutate(args.projectId, [work.id], { screening: "included" });
        return work;
      }
      case "setSeeds":
        return this.db.setSeeds(
          args.projectId,
          args.ids,
          args.question,
          args.groups,
        );
      case "startRun":
        if (this.pdf.active.size)
          throw new AppError("BUSY", "PDF 가져오기 완료 후 탐색하세요.");
        return this.discovery.start(args);
      case "controlRun": {
        const run = this.db.run(args.runId);
        if (
          run.retryAt &&
          Date.parse(run.retryAt) > Date.now() &&
          args.action !== "cancel"
        )
          throw new AppError(
            "RATE_LIMIT",
            "요청 한도 대기 시간 후 재개하세요.",
          );
        if (run.import) return this.pdf.control(args.runId, args.action);
        return this.discovery.control(args.runId, args.action);
      }
      case "previewBib":
        return this.preview(args.text);
      case "previewBibFile":
        if ((await stat(args.path)).size > 20_000_000)
          throw new AppError(
            "FILE_SIZE",
            "20MB 이하의 BibTeX 파일을 선택하세요.",
          );
        return this.preview(await readFile(args.path, "utf8"));
      case "importBib":
        return this.importBib(args);
      case "pdfImport":
        if (this.busy())
          throw new AppError("BUSY", "진행 중인 작업을 완료하거나 취소하세요.");
        return this.pdf.start(args.projectId, args.paths, args.options);
      case "attachments":
        return this.db.attachments(args.workId);
      case "importItems":
        return this.db.db
          .prepare(
            "SELECT name,status,message,work_id AS workId FROM import_items WHERE run_id=?",
          )
          .all(args.runId);
      case "attachmentPath": {
        const a = this.db.attachment(args.attachmentId);
        await verifyPdf(a.path);
        return a.path;
      }
      case "relink": {
        await verifyPdf(args.path);
        const a = this.db.attachment(args.attachmentId);
        if ((await hashFile(args.path)) !== a.hash)
          throw new AppError(
            "HASH_MISMATCH",
            "기존 첨부와 내용이 다른 PDF입니다. 새 첨부로 가져오세요.",
          );
        this.db.saveAttachment({
          ...a,
          path: args.path,
          mode: "linked",
          exists: true,
          status: "재연결됨",
        });
        return;
      }
      case "performExport":
        return this.performExport(args);
      case "exportPreview": {
        const ids = this.exportIds(args);
        return { ids, count: ids.length };
      }
      case "backup":
        if (this.busy())
          throw new AppError("BUSY", "진행 중인 작업이 끝난 뒤 백업하세요.");
        return createBackup(
          this.db,
          args.path,
          args.includeAttachments,
          args.includeLinked,
        );
      case "restore":
        if (this.busy())
          throw new AppError("BUSY", "진행 중인 작업이 끝난 뒤 복원하세요.");
        return restoreBackup(args.path, args.destination);
      case "saveSettings": {
        const {
          model,
          aiEnabled,
          aiMaxInputTokens,
          aiMaxOutputTokens,
          aiBudgetUsd,
          inputPricePerMillion,
          outputPricePerMillion,
        } = args;
        this.db.pref("ai", {
          model,
          aiEnabled,
          aiMaxInputTokens,
          aiMaxOutputTokens,
          aiBudgetUsd,
          inputPricePerMillion,
          outputPricePerMillion,
        });
        this.db.pref("theme", args.theme);
        return this.settings();
      }
      case "testConnection": {
        if (this.busy())
          throw new AppError("BUSY", "현재 작업이 끝난 뒤 연결을 확인하세요.");
        if (args.provider === "openalex") {
          await this.oa.page(
            { per_page: "1" },
            AbortSignal.timeout(15000),
            () => this.db.usage("openalex", "connection"),
          );
          return {
            message: this.secrets.openalex
              ? "OpenAlex 연결 확인"
              : "키 없는 제한적 연결 확인 · 지속 사용하려면 키를 등록하세요.",
          };
        }
        if (!this.secrets.openai)
          throw new AppError("API_KEY", "OpenAI 키를 먼저 등록하세요.");
        const response = await fetch(
          `https://api.openai.com/v1/models/${encodeURIComponent(this.settings().model)}`,
          {
            headers: { Authorization: `Bearer ${this.secrets.openai}` },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok)
          throw new AppError(
            "AI_PROVIDER",
            `모델 연결 실패 (${response.status})`,
          );
        return { message: "OpenAI 모델 접근 확인 · 생성 호출 없음" };
      }
      case "externalUrl": {
        const work = this.db.get(args.workId);
        return safeWebUrl(
          args.kind === "doi"
            ? work.doi
              ? `https://doi.org/${work.doi}`
              : null
            : args.kind === "oa"
              ? work.oaUrl
              : work.url,
        );
      }
      case "saveUi":
        this.db.pref("ui:" + args.projectId, args.value);
        return;
      case "undo":
        return this.db.undo(args.projectId);
      case "duplicates": {
        const w = this.db.get(args.workId);
        return (
          this.db.db.prepare("SELECT id FROM works WHERE id!=?").all(w.id) as {
            id: string;
          }[]
        )
          .filter(
            (r) => titleSimilarity(this.db.get(r.id).title, w.title) > 0.6,
          )
          .slice(0, 20)
          .map((r) => this.db.view(this.db.projects()[0].id, r.id));
      }
      case "merge":
        if (this.busy()) throw new AppError("BUSY", "작업 종료 후 병합하세요.");
        mergeWorks(this.db, args.keepId, args.removeId);
        return;
      case "undoMerge":
        if (this.busy()) throw new AppError("BUSY", "작업 종료 후 되돌리세요.");
        return undoMerge(this.db);
      case "shutdown":
        for (const control of [
          ...this.discovery.active.values(),
          ...this.pdf.active.values(),
        ])
          control.abort();
        return;
      default:
        throw new AppError("UNKNOWN_COMMAND", "허용되지 않은 작업입니다.");
    }
  }
  preview(text: string): ImportPreview {
    const entries = parseBib(text);
    const token = randomUUID();
    if (this.previews.size > 8)
      this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(token, entries);
    return {
      token,
      items: entries.map((e) => {
        if (!e.work)
          return {
            title: e.name,
            citekey: e.name,
            status: "error",
            message: e.error || "",
          };
        const match = this.db.match(e.work);
        return {
          title: e.work.title,
          citekey: e.work.citekey,
          status: match.conflict ? "conflict" : match.id ? "existing" : "new",
          message: match.conflict || "",
        };
      }),
    };
  }
  importBib(args: {
    projectId: string;
    token: string;
    collectionId?: string;
  }): ImportResult {
    const entries = this.previews.get(args.token);
    if (!entries)
      throw new AppError(
        "PREVIEW_EXPIRED",
        "미리보기가 만료되었습니다. 다시 가져오세요.",
      );
    if (
      args.collectionId &&
      !this.db
        .collections(args.projectId)
        .some((c) => c.id === args.collectionId)
    )
      throw new AppError("INVALID", "컬렉션을 찾을 수 없습니다.");
    const result: ImportResult = {
      added: 0,
      linked: 0,
      pending: 0,
      errors: [],
      ids: [],
    };
    this.db.transaction(() => {
      for (const entry of entries) {
        if (!entry.work) {
          result.errors.push({
            name: entry.name,
            message: entry.error || "파싱 실패",
          });
          continue;
        }
        try {
          const { work, existing } = this.db.upsert(entry.work);
          this.db.ensureMembership(args.projectId, work.id);
          if (args.collectionId)
            this.db.db
              .prepare("INSERT OR IGNORE INTO collection_works VALUES(?,?)")
              .run(args.collectionId, work.id);
          if (existing) result.linked++;
          else result.added++;
          result.ids.push(work.id);
        } catch (error) {
          result.errors.push({
            name: entry.name,
            message: error instanceof AppError ? error.message : "저장 실패",
          });
        }
      }
    });
    return result;
  }
  exportIds(args: any): string[] {
    let ids: string[] = args.ids || [];
    if (args.scope === "project")
      ids = (
        this.db.db
          .prepare(
            "SELECT work_id AS id FROM project_works WHERE project_id=? AND json_extract(state,'$.screening')='included'",
          )
          .all(args.projectId) as { id: string }[]
      ).map((r) => r.id);
    if (args.scope === "all")
      ids = (
        this.db.db
          .prepare(
            "SELECT DISTINCT work_id AS id FROM project_works WHERE json_extract(state,'$.screening')='included'",
          )
          .all() as { id: string }[]
      ).map((r) => r.id);
    if (args.scope === "collection") {
      if (
        !this.db
          .collections(args.projectId)
          .some((c) => c.id === args.collectionId)
      )
        throw new AppError("INVALID", "컬렉션을 찾을 수 없습니다.");
      ids = (
        this.db.db
          .prepare(
            "SELECT cw.work_id AS id FROM collection_works cw JOIN project_works pw ON pw.work_id=cw.work_id WHERE collection_id=? AND pw.project_id=? AND json_extract(pw.state,'$.screening')!='trash'",
          )
          .all(args.collectionId, args.projectId) as { id: string }[]
      ).map((r) => r.id);
    }
    ids = [...new Set(ids)];
    return ids;
  }
  async performExport(args: any) {
    const ids = this.exportIds(args);
    if (!ids.length)
      throw new AppError("EMPTY_EXPORT", "내보낼 문헌이 없습니다.");
    const works = ids.map((id) => this.db.view(args.projectId, id));
    const files = Object.fromEntries(
      ids.map((id) => [id, this.db.attachments(id).map((a) => a.path)]),
    );
    const result = exportBib(works, {
      includeNotes: args.includeNotes,
      includeFiles: args.includeFiles,
      files,
    });
    const staging = args.path + "." + randomUUID() + ".staging";
    await writeFile(staging, result.text, { flag: "wx" });
    await rename(staging, args.path);
    this.db.db
      .prepare("INSERT INTO export_records VALUES(?,?,?)")
      .run(
        randomUUID(),
        JSON.stringify({ ids, mappings: result.mappings, scope: args.scope }),
        new Date().toISOString(),
      );
    return { path: args.path, count: ids.length, mappings: result.mappings };
  }
}
