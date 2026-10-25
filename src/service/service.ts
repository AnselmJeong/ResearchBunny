import { PdfReader } from "./interchange/pdf-reader";
import { ArticleChat } from "./chat/service";
import { ChatProvider } from "./chat/provider";
import { OllamaCloud } from "./providers/ollama";
import { searchPubMedIds } from "./search/pubmed-search";
import { searchWebWithTinyFish } from "./search/web-search";
import { CodexClient } from "./codex/client";
import { ClaudeClient } from "./claude/client";
import { GenealogyAI } from "./genealogy/llm";
import { GenealogyEngine } from "./genealogy/engine";
import { GenealogyStore } from "./genealogy/store";
import { genealogyTools } from "./genealogy/tools";
import { defaultGenealogySettings } from "../shared/genealogy";
import { version } from "../../package.json";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AppEvent,
  ImportPreview,
  ImportResult,
  Run,
  Settings,
} from "../shared/types";
import { AppError, DEFAULT_FILTERS, now, type Attachment } from "../shared/types";
import { blankWork, cleanQueries, titleSimilarity, safeWebUrl, pmidOf } from "../shared/domain";
import { Library } from "./db/database";
import { LinkedDiscoveries } from "./providers/linked-discoveries";
import { OpenAlex } from "./providers/openalex";
import { AIProvider, DEFAULT_AI, type AIConfig } from "./providers/openai";
import { Discovery } from "./discovery/engine";
import { Links } from "./discovery/links";
import { parseBib, exportBib, type BibEntry } from "./interchange/bibtex";
import { PdfImports, hashFile, verifyPdf } from "./interchange/pdf";
import { createBackup, restoreBackup } from "./interchange/backup";
import { mergeWorks, undoMerge } from "./db/merge";
import { deleteTrashedWorks, settledUi, trashTargets } from "./db/trash";
import { deleteProject } from "./db/projects";
import { ArchiveClassifier, classificationSnapshot } from "./archive-classification";
import { PdfDownloads } from "./fulltext/jobs";
import { planPdfExport, pdfExportTargets, previewPdfExport, exportPdfFolders } from "./interchange/pdf-export";
import { schemas, type TrashDeletion } from "../shared/contracts";
import { Shelf } from "./shelf/indexer";
import { ShelfQueries } from "./shelf/search";
import { SHELF_ALL } from "../shared/shelf";
import { ShelfSorter, logDeletion } from "./shelf/sorter";
import { rootOnline } from "./shelf/scanner";
import { searchEvidence, type SearchKeys } from "./chat/search";
import type { ChatSource } from "../shared/chat";
export class Service {
  db: Library;
  oa: OpenAlex;
  ai: AIProvider;
  codex: CodexClient;
  claude: ClaudeClient;
  ollama: OllamaCloud;
  chat: ArticleChat;
  reader: PdfReader;
  discovery: Discovery;
  links: Links;
  pdf: PdfImports;
  downloads: PdfDownloads;
  classifier: ArchiveClassifier;
  shelf: Shelf;
  shelfQueries: ShelfQueries;
  sorter: ShelfSorter;
  genealogy: GenealogyEngine;
  secrets: {
    openalex?: string;
    openai?: string;
    ollama?: string;
    pubmed?: string;
    tinyfish?: string;
    secureStorage?: boolean;
    credentialMigrationRequired?: boolean;
  } = {};
  previews = new Map<string, BibEntry[]>();
  externalEvidence = searchEvidence;
  constructor(
    root: string,
    workerPath: string,
    private emit: (event: AppEvent) => void,
    codex = new CodexClient(),
    claude = new ClaudeClient(),
  ) {
    this.codex = codex;
    this.claude = claude;
    this.db = new Library(root);
    this.oa = new OpenAlex(this.db, () => this.secrets.openalex);
    this.ollama = new OllamaCloud(() => this.secrets.ollama);
    this.reader = new PdfReader(this.db, workerPath);
    this.shelf = new Shelf(this.db, this.oa, workerPath, emit, () => this.secrets);
    this.shelfQueries = new ShelfQueries(this.db, this.shelf);
    this.db.shelfHints = (works) => this.shelfQueries.hints(works);
    this.chat = new ArticleChat(this.db, () => this.settings(), () => this.secrets, new ChatProvider(this.ollama, this.codex, () => this.secrets.openai, fetch, this.claude), emit, (query, keys, signal) => this.evidence(query, keys, signal), (projectId, workId, attachmentId, signal) => this.reader.context({ projectId, workId, attachmentId }, signal));
    this.ai = new AIProvider(
      this.db,
      () => this.secrets.openai,
      () => this.settings(),
      fetch,
      this.codex,
      this.ollama,
      this.claude,
    );
    this.discovery = new Discovery(this.db, this.oa, emit, this.ai, new LinkedDiscoveries(this.db), {
      enabled: () => !!this.shelf.root(),
      search: async (query, limit, signal) => (await this.shelfQueries.search(query, { limit, signal })).hits,
      similar: (ids, limit, signal) => this.similarInShelf(ids, limit, signal),
    });
    this.links = new Links(this.db, this.oa, new LinkedDiscoveries(this.db), {
      enabled: () => !!this.shelf.root(),
      similar: async (workId, limit, otherFolders, signal) => {
        const related = await this.shelfQueries.related(workId, { limit, otherFoldersOnly: otherFolders, signal });
        return {
          hits: related.similar.map((item) => ({ workId: item.workId, score: item.score })),
          notice: related.semantic ? related.notice : "Ollama 임베딩을 쓸 수 없어 서고에서 비슷한 논문은 찾지 못했습니다.",
        };
      },
    });
    this.pdf = new PdfImports(this.db, this.oa, workerPath, emit);
    this.downloads = new PdfDownloads(this.db, workerPath, emit);
    // With a shelf, every PDF the app obtains is stored in its inbox; there is no second store.
    const inbox = {
      configured: () => !!this.shelf.root(),
      deposit: (path: string, workId: string, options: { hash: string; signal: AbortSignal; fields: Partial<Attachment> }) => this.shelf.deposit(path, workId, options),
    };
    this.downloads.shelf = {
      ...inbox,
      match: (work) => this.shelf.root() ? this.shelfQueries.heldBy(work).map((m) => ({ fileId: m.fileId, name: m.path.split("/").pop() || m.title, folder: m.folder, own: m.own })) : [],
      attach: (fileId, workId) => this.shelf.attachTo(fileId, workId),
    };
    this.pdf.shelf = inbox;
    this.classifier = new ArchiveClassifier(this.db, this.ai, emit);
    this.sorter = new ShelfSorter(this.db, this.shelf, this.shelfQueries, this.ai, emit);
    this.genealogy = new GenealogyEngine({
      db: this.db,
      store: new GenealogyStore(this.db),
      ai: new GenealogyAI(this.db, { codex: this.codex, claude: this.claude, ollama: this.ollama }),
      oa: this.oa,
      downloads: this.downloads,
      workerPath,
      emit,
      pubmedKey: () => this.secrets.pubmed,
      shelfWritable: () => this.shelfWritable().then(() => true, () => false),
      busy: () => this.discovery.active.size > 0 || this.pdf.active.size > 0 || this.downloads.active.size > 0 || !!this.sorter.active,
      tools: genealogyTools,
    });
  }
  /** Downloads and imports are stored in the shelf inbox: refuse to start while a configured shelf is offline. */
  /**
   * Permanent deletion takes the papers' shelf PDFs out of the app, in every
   * folder, so the shelf never lists them again. By default (`keep`) the PDFs
   * stay on disk and are only hidden; `delete` deletes them from disk. Files go
   * first there: a paper whose PDF cannot be deleted stays in the trash.
   */
  private async deleteTrash(projectId: string, selected: string[] | undefined, pdfs: "keep" | "delete"): Promise<TrashDeletion> {
    const ids = trashTargets(this.db, projectId, selected);
    const files = this.shelf.filesOf(ids);
    if (!files.length) return { ...deleteTrashedWorks(this.db, projectId, ids), shelf: { deleted: [], hidden: [], failed: [] } };
    // Hiding never touches the disk, so an offline shelf does not stop it.
    if (pdfs === "keep")
      return this.shelf.hold(async () => this.db.transaction(() => {
        const result = deleteTrashedWorks(this.db, projectId, ids);
        return { ...result, shelf: { deleted: [], hidden: this.shelf.hide(files), failed: [] } };
      }));
    const root = this.shelf.root()!;
    if (!(await rootOnline(root.path)))
      throw new AppError("SHELF_OFFLINE", `서고(${root.path})가 연결되지 않아 서고 PDF를 지울 수 없습니다. NAS를 연결한 뒤 영구 삭제하세요.`);
    return this.shelf.hold(async () => {
      const { deleted, failed } = await this.shelf.unlinkFiles(files);
      const kept = new Set(failed.flatMap((f) => this.shelf.owners(f.row, ids)));
      const result = deleteTrashedWorks(this.db, projectId, ids.filter((id) => !kept.has(id)));
      this.shelf.drop(deleted.map((f) => f.id));
      await logDeletion(root.path, deleted.filter((f) => f.status !== "missing").map((f) => f.rel_path)).catch(() => false);
      return {
        ...result,
        shelf: { deleted: deleted.map((f) => f.rel_path), hidden: [], failed: failed.map((f) => ({ relPath: f.row.rel_path, reason: f.reason })) },
      };
    });
  }
  private async shelfWritable() {
    if (this.shelf.root()) await this.shelf.writableRoot();
  }
  /** Shelf papers first (top 3 abstracts), then the usual OpenAlex · PubMed evidence. */
  async evidence(query: string, keys: SearchKeys, signal: AbortSignal) {
    const [external, shelf] = await Promise.all([
      this.externalEvidence(query, keys, signal),
      this.shelf.root()
        ? this.shelfQueries.search(query, { limit: 3, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const sources: ChatSource[] = (shelf?.hits || []).flatMap((hit) => {
      const work = this.db.get(hit.workId);
      return work.abstract
        ? [{ title: work.title.slice(0, 600), content: `Source: 내 서고 (${hit.folder})\n${[work.authors.slice(0, 4).join("; "), work.year, work.venue].filter(Boolean).join(". ")}\nAbstract: ${work.abstract}`.slice(0, 2400), source: "shelf" as const, workId: work.id, ...(work.doi ? { doi: work.doi } : {}) }]
        : [];
    });
    const known = new Set(sources.map((s) => s.doi).filter(Boolean));
    return { sources: [...sources, ...external.sources.filter((s) => !s.doi || !known.has(s.doi))], notice: external.notice };
  }
  /** Shelf papers closest to the given works, for offline "related" exploration. */
  async similarInShelf(ids: string[], limit: number, signal: AbortSignal) {
    const scores = new Map<string, { score: number; folder: string }>();
    for (const id of ids) {
      const related = await this.shelfQueries.related(id, { limit, otherFoldersOnly: false, signal });
      for (const item of related.similar)
        if (!ids.includes(item.workId) && (scores.get(item.workId)?.score ?? -1) < item.score)
          scores.set(item.workId, { score: item.score, folder: item.folder });
    }
    const memberships = this.db.shelfMemberships([...scores.keys()]);
    return [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([workId, v]) => ({ workId, score: v.score, folder: v.folder, folderId: memberships.get(workId)?.folderId || "", lexicalRank: null, semanticRank: null }));
  }
  /** A throwaway run carries the AI call limits; nothing is saved for it. */
  private seedQueries(projectId: string, question: string) {
    const run: Run = {
      id: randomUUID(), projectId, mode: "ai", query: question, seedProfileId: null,
      inputIds: [], filters: DEFAULT_FILTERS, status: "running", createdAt: now(), updatedAt: now(),
      calls: 0, maxCalls: 0, maxCandidates: 0, total: null, count: 0,
      message: "", tasks: [], rankingVersion: "seed-queries-1",
    };
    return this.ai.seedQueries(question, run, AbortSignal.timeout(120000), false);
  }
  busy() {
    return this.chat.active.size > 0 || this.discovery.active.size > 0 || this.pdf.active.size > 0 || this.downloads.active.size > 0 || this.classifier.active.size > 0 || !!this.sorter.active || this.genealogy.active.size > 0;
  }
  settings(): Settings {
    const saved = this.db.pref<Partial<AIConfig>>("ai");
    return {
      ...DEFAULT_AI,
      ...saved,
      ...(saved && !saved.aiProvider ? { aiProvider: "codex" as const } : {}),
      openalexConfigured: !!this.secrets.openalex,
      openaiConfigured: !!this.secrets.openai,
      ollamaConfigured: !!this.secrets.ollama,
      pubmedConfigured: !!this.secrets.pubmed,
      tinyfishConfigured: !!this.secrets.tinyfish,
      secureStorage: this.secrets.secureStorage ?? null,
      credentialMigrationRequired: this.secrets.credentialMigrationRequired,
      linkedDiscoveries: this.db.pref<boolean>("linkedDiscoveries") === true,
      theme: this.db.pref<Settings["theme"]>("theme") || "system",
      dataPath: this.db.root,
      version,
      usage: this.db.usageSummary(),
    };
  }
  async call(command: string, args: any): Promise<any> {
    switch (command) {
      case "init":
        this.secrets = args;
        this.downloads.startRecoveryMonitor(() => this.busy());
        this.shelf.start();
        return true;
      case "rememberDownloadDirectory":
        return this.downloads.rememberDirectory(args.directory);
      case "snapshot": {
        const projectId = args.projectId || this.db.projects()[0].id;
        this.db.project(projectId);
        // Opening a project moves it to the top of the list, and the app reopens it next time.
        this.db.openProject(projectId);
        await this.downloads.syncHistory();
        const history = this.db.seedHistory(projectId);
        return {
          projects: this.db.projects(),
          collections: this.db.collections(projectId),
          classification: classificationSnapshot(this.db, projectId),
          seeds: history[0] || null,
          seedHistory: history,
          runs: this.db.runs(projectId),
          counts: this.db.counts(projectId),
          settings: this.settings(),
          shelf: this.shelf.summary(projectId),
          genealogies: this.genealogy.store.list(projectId),
          ui: settledUi(this.db, projectId),
        };
      }
      case "createProject":
        return this.db.createProject(args.name, args.question);
      case "updateProject":
        return this.db.updateProject(args.projectId, args.name, args.question);
      case "projectStats":
        return this.db.projectStats();
      case "deleteProject":
        if (this.busy())
          throw new AppError("BUSY", "탐색·가져오기·자동 분류·AI 대화 작업이 끝난 뒤 프로젝트를 삭제하세요.");
        return deleteProject(this.db, args.projectId);
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
        // In the shelf the query is a hybrid (meaning + words) search; elsewhere it filters by substring.
        if (args.scope === "shelf" && args.query?.trim() && this.shelf.root()) {
          const search = await this.shelfQueries.search(args.query.trim(), { limit: 200, folderIds: [args.scopeId || SHELF_ALL] });
          return this.db.list(args, search);
        }
        return this.db.list(args);
      case "classifyArchive":
        if (this.busy()) throw new AppError("BUSY", "진행 중인 작업이 끝난 뒤 자동 분류하세요.");
        return this.classifier.start(args.projectId);
      case "cancelClassification":
        this.classifier.cancel(args.projectId);
        return;
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
      case "unarchiveWorks":
        return this.db.unarchive(args.projectId, args.ids);
      case "trashWorks":
        return this.db.trash(args.projectId, args.ids, args.keepCollected);
      case "clearPending":
        if (this.busy())
          throw new AppError("BUSY", "진행 중인 작업이 끝난 뒤 검토 대기함을 비우세요.");
        return this.db.clearPending(args.projectId);
      case "deleteTrashedWorks":
        if (this.busy())
          throw new AppError(
            "BUSY",
            "탐색·가져오기 작업이 끝난 뒤 영구 삭제하세요.",
          );
        return this.deleteTrash(
          args.projectId,
          args.target.kind === "selected" ? args.target.ids : undefined,
          // The safe choice also when a caller skips the schema default.
          args.pdfs === "delete" ? "delete" : "keep",
        );
      case "previewTrashDeletion": {
        const ids = trashTargets(this.db, args.projectId, args.target.kind === "selected" ? args.target.ids : undefined);
        return { count: ids.length, shelfFiles: this.shelf.filesOf(ids).filter((f) => f.status !== "missing").map((f) => f.rel_path) };
      }
      case "editWork": {
        const work = this.db.edit(args.workId, args.patch);
        if (this.db.db.prepare("SELECT 1 FROM shelf_files WHERE work_id=? LIMIT 1").get(work.id)) {
          this.shelf.ftsRefresh(work.id);
          this.shelf.revision++;
          void this.shelf.embed(AbortSignal.timeout(60000), [work.id]).catch(() => {});
        }
        return work;
      }
      case "manualWork": {
        const { work } = this.db.upsert(blankWork(args.metadata));
        this.db.mutate(args.projectId, [work.id], { screening: "included" });
        return work;
      }
      case "setSeeds": {
        const latest = this.db.seedHistory(args.projectId)[0];
        let queries = cleanQueries(
          args.queries ?? (latest?.question === args.question ? latest.queries || [] : []),
        );
        // Write the English queries with the question; a failure leaves them to the next exploration.
        if (!queries.length && args.question.trim())
          queries = await this.seedQueries(args.projectId, args.question).catch(() => []);
        return this.db.setSeeds(
          args.projectId,
          args.ids,
          args.question,
          args.groups,
          queries,
        );
      }
      case "seedQueries":
        return { queries: await this.seedQueries(args.projectId, args.question) };
      case "startRun":
        if (this.pdf.active.size || this.downloads.active.size)
          throw new AppError("BUSY", "PDF 가져오기 완료 후 탐색하세요.");
        return this.discovery.start(args);
      case "controlRun": {
        const run = this.db.run(args.runId);
        if (run.download) {
          if (!["cancel", "skip"].includes(args.action) && this.busy()) throw new AppError("BUSY", "진행 중인 작업을 완료하거나 취소하세요.");
          if (args.action === "resume") await this.shelfWritable();
          return this.downloads.control(args.runId, args.action, args.useBrowser, args.downloadDirectory, args.useSciHub);
        }
        if (args.action === "skip") throw new AppError("INVALID", "문헌 건너뛰기는 원문 확보 작업에서 사용하세요.");
        if (args.action !== "cancel" && this.downloads.active.size) throw new AppError("BUSY", "원문 확보 작업을 완료하거나 취소하세요.");
        if (
          run.retryAt &&
          Date.parse(run.retryAt) > Date.now() &&
          args.action !== "cancel"
        )
          throw new AppError(
            "RATE_LIMIT",
            "요청 한도 대기 시간 후 재개하세요.",
          );
        if (run.import) {
          if (args.action !== "cancel" && run.import.mode === "managed") await this.shelfWritable();
          return this.pdf.control(args.runId, args.action);
        }
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
        if (args.options?.mode === "managed") await this.shelfWritable();
        return this.pdf.start(args.projectId, args.paths, args.options);
      case "pdfMatch":
        if (this.busy()) throw new AppError("BUSY", "진행 중인 작업을 완료하거나 취소하세요.");
        await this.shelfWritable();
        return this.pdf.start(args.projectId, args.paths, { mode: "managed", matchExistingOnly: true });
      case "pdfInfo": return this.reader.info(schemas.pdfInfo.parse(args));
      case "pdfReadChunk": return this.reader.chunk(schemas.pdfReadChunk.parse(args));
      case "attachments":
        return this.db.attachments(args.workId);
      case "pdfDownloadPreview":
        return this.downloads.preview(args);
      case "missingPdfs":
        return this.downloads.missing(args);
      case "downloadPdfs":
        if (this.busy()) throw new AppError("BUSY", "진행 중인 작업을 완료하거나 취소하세요.");
        await this.shelfWritable();
        return this.downloads.start(args);
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
      case "pdfExportPreview":
        return previewPdfExport(planPdfExport(this.db, pdfExportTargets(this.db, schemas.pdfExportPreview.parse(args))));
      case "performPdfExport": {
        const { targets } = schemas.exportPdfs.parse(args);
        const result = await exportPdfFolders(planPdfExport(this.db, targets), args.parent);
        this.db.db.prepare("INSERT INTO export_records VALUES(?,?,?)").run(
          randomUUID(), JSON.stringify({ format: "pdf-folders", targets, ...result }), new Date().toISOString(),
        );
        return result;
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
      case "chatSession": { const p = schemas.chatSession.parse(args); return this.chat.select(p.projectId, p.workId, p.context, p.threadId); }
      case "chatThreads": { const p = schemas.chatThreads.parse(args); return this.chat.threads(p.projectId, p.workId, p.context); }
      case "chatSend": return this.chat.start(schemas.chatSend.parse(args));
      case "chatCancel": { const p = schemas.chatCancel.parse(args); return this.chat.cancel(p.projectId, p.workId, p.requestId, p.context, p.threadId); }
      case "chatClear": { const p = schemas.chatClear.parse(args); return this.chat.clear(p.projectId, p.workId, p.context, p.threadId); }
      case "chatSourceUrl": { const p = schemas.chatOpenSource.parse(args); return this.chat.sourceUrl(p.projectId, p.workId, p.messageId, p.index, p.context, p.threadId); }
      case "ollamaModels": return this.ollama.models();
      case "codexStatus": return this.codex.status();
      case "codexModels":
      case "codexLogin":
      case "codexCancelLogin":
      case "codexLogout": {
        try {
          if (command === "codexModels") return await this.codex.models();
          if (command === "codexLogin") return await this.codex.login();
          if (command === "codexCancelLogin") return await this.codex.cancelLogin();
          if (this.busy()) throw new AppError("BUSY", "AI 작업을 취소한 뒤 로그아웃하세요.");
          return await this.codex.logout();
        } catch (error) {
          throw new AppError("CODEX_CONNECTION", error instanceof Error ? error.message : "Codex 연결에 실패했습니다.");
        }
      }
      case "genealogies": return this.genealogy.store.list(schemas.genealogies.parse(args).projectId);
      case "genealogyCreate": {
        const p = schemas.genealogyCreate.parse(args);
        const project = this.db.project(p.projectId);
        const seed = this.db.seedHistory(p.projectId)[0];
        const settings = { ...defaultGenealogySettings(this.settings(), project.question || seed?.question || ""), ...p.settings };
        return this.genealogy.create({ projectId: p.projectId, collectionId: p.collectionId, title: p.title, settings, workspace: p.workspace });
      }
      case "genealogyView": return this.genealogy.view(schemas.genealogyView.parse(args).id);
      case "genealogyUpdate": { const p = schemas.genealogyUpdate.parse(args); return this.genealogy.update(p.id, p); }
      case "genealogyType": { const p = schemas.genealogyType.parse(args); return this.genealogy.setType(p.id, p.workId, p.type); }
      case "genealogyStart": {
        const p = schemas.genealogyStart.parse(args);
        if (this.genealogy.active.size === 0 && (this.discovery.active.size || this.pdf.active.size || this.downloads.active.size || this.sorter.active))
          throw new AppError("BUSY", "진행 중인 탐색·가져오기·원문 확보·정리 작업이 끝난 뒤 실행하세요.");
        return this.genealogy.start(p.id, p.step, p.auto);
      }
      case "genealogyCancel": return this.genealogy.cancel(schemas.genealogyCancel.parse(args).id);
      case "genealogyDelete": return this.genealogy.remove(schemas.genealogyDelete.parse(args).id);
      case "genealogyWorkspace": return this.genealogy.store.get(schemas.genealogyReveal.parse(args).id).workspace;
      case "claudeStatus": return this.claude.status();
      case "claudeModels":
      case "claudeLogin":
      case "claudeCancelLogin":
      case "claudeLogout": {
        try {
          if (command === "claudeModels") return await this.claude.models();
          if (command === "claudeLogin") return await this.claude.login();
          if (command === "claudeCancelLogin") return await this.claude.cancelLogin();
          if (this.busy()) throw new AppError("BUSY", "AI 작업을 취소한 뒤 로그아웃하세요.");
          return await this.claude.logout();
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("CLAUDE_CONNECTION", error instanceof Error ? error.message : "Claude 연결에 실패했습니다.");
        }
      }
      case "saveSettings": {
        const {
          model,
          aiProvider,
          codexModel,
          claudeModel,
          ollamaModel,
          aiEnabled,
          aiMaxInputTokens,
          aiMaxOutputTokens,
          aiBudgetUsd,
          inputPricePerMillion,
          outputPricePerMillion,
        } = args;
        this.db.pref("ai", {
          model,
          aiProvider: aiProvider ?? this.settings().aiProvider,
          codexModel,
          claudeModel: claudeModel ?? "",
          ollamaModel: ollamaModel ?? this.settings().ollamaModel,
          aiEnabled,
          aiMaxInputTokens,
          aiMaxOutputTokens,
          aiBudgetUsd,
          inputPricePerMillion,
          outputPricePerMillion,
        });
        this.db.pref("theme", args.theme);
        if (typeof args.linkedDiscoveries === "boolean")
          this.db.pref("linkedDiscoveries", args.linkedDiscoveries);
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
        if (args.provider === "ollama") {
          const models = await this.ollama.models();
          if (!models.includes(this.settings().ollamaModel)) throw new AppError("OLLAMA_MODEL", "선택한 Ollama 모델이 목록에 없습니다. 모델 목록을 새로고침하세요.");
          return { message: `Ollama Cloud 연결 확인 · ${models.length}개 모델 · 생성 호출 없음` };
        }
        if (args.provider === "pubmed") {
          try { await searchPubMedIds("neuroscience", 1, { apiKey: this.secrets.pubmed, signal: AbortSignal.timeout(15000) }); }
          catch { throw new AppError("PUBMED_CONNECTION", "PubMed 연결 실패. NCBI 키와 네트워크를 확인하세요."); }
          return { message: this.secrets.pubmed ? "PubMed 연결 확인" : "PubMed 키 없는 연결 확인" };
        }
        if (args.provider === "tinyfish") {
          if (!this.secrets.tinyfish) throw new AppError("API_KEY", "TinyFish 키를 먼저 등록하세요.");
          try { await searchWebWithTinyFish("site:pubmed.ncbi.nlm.nih.gov neuroscience", { tinyfishApiKey: this.secrets.tinyfish, webSearchEnabled: true }, 1, AbortSignal.timeout(15000)); }
          catch { throw new AppError("TINYFISH_CONNECTION", "TinyFish 연결 실패. Search API 키·사용 한도·네트워크를 확인하세요."); }
          return { message: "TinyFish 검색 연결 확인 · 검색 1회 사용" };
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
          args.kind === "linked-discoveries"
            ? pmidOf(work) ? `https://linkeddiscoveries.ncbi.nlm.nih.gov/${pmidOf(work)}/` : null
            : args.kind === "doi"
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
        // Compare titles only; parsing every full record does not scale with the shelf.
        const ids = (
          this.db.db.prepare("SELECT id,json_extract(data,'$.title') AS title FROM works WHERE id!=?").all(w.id) as { id: string; title: string | null }[]
        )
          .filter((r) => titleSimilarity(r.title || "", w.title) > 0.6)
          .slice(0, 20)
          .map((r) => r.id);
        return this.db.views(this.db.projects()[0].id, ids);
      }
      case "merge":
        if (this.busy()) throw new AppError("BUSY", "작업 종료 후 병합하세요.");
        mergeWorks(this.db, args.keepId, args.removeId);
        this.shelf.ftsRefresh(args.keepId);
        this.shelf.vectors.loaded = false;
        this.shelf.revision++;
        return;
      case "undoMerge": {
        if (this.busy()) throw new AppError("BUSY", "작업 종료 후 되돌리세요.");
        const undone = undoMerge(this.db);
        if (undone) {
          this.shelf.ftsRebuild();
          this.shelf.vectors.loaded = false;
        }
        return undone;
      }
      case "shelfStatus":
        return this.shelf.status();
      case "shelfConfigure": {
        const p = schemas.shelfConfigure.parse(args);
        const root = this.shelf.root();
        // Downloads, imports and inbox sorting write into the shelf folder while they run.
        if (root && resolve(p.path) !== root.path && (this.pdf.active.size || this.downloads.active.size || this.sorter.active))
          throw new AppError("BUSY", "PDF 확보·가져오기·수신함 정리가 끝난 뒤 서고 위치를 바꾸세요.");
        await this.shelf.configure(p);
        void this.shelf.scan("configure");
        return this.shelf.status();
      }
      case "shelfMovePreview":
        return this.shelf.previewMove(schemas.shelfMovePreview.parse(args).path);
      case "shelfControl":
        this.shelf.command(schemas.shelfControl.parse(args).action);
        return;
      case "shelfAdopt":
        schemas.shelfAdopt.parse(args);
        if (this.busy()) throw new AppError("BUSY", "진행 중인 작업을 완료하거나 취소하세요.");
        return this.shelf.adoptManaged();
      case "shelfPull": {
        const config = this.shelf.config();
        if (!config) throw new AppError("SHELF_CONFIG", "서고 위치를 먼저 설정하세요.");
        void this.shelf.pullModel().catch(() => {});
        return;
      }
      case "shelfRelated": {
        const p = schemas.shelfRelated.parse(args);
        this.db.project(p.projectId);
        return this.shelfQueries.related(p.workId, { limit: p.limit, otherFoldersOnly: p.otherFoldersOnly });
      }
      case "shelfSearch": {
        const p = schemas.shelfSearch.parse(args);
        this.db.project(p.projectId);
        return this.shelfQueries.search(p.query, { limit: p.limit });
      }
      case "workLinks": {
        const p = schemas.workLinks.parse(args);
        this.db.project(p.projectId);
        return this.links.load(p);
      }
      case "shelfFile":
        return this.shelf.fileDetails(schemas.shelfFile.parse(args).fileId);
      case "shelfResolve": {
        const p = schemas.shelfResolve.parse(args);
        if (p.action === "keep") this.shelf.keepProvisional(p.fileId);
        else {
          if (!p.value) throw new AppError("INVALID", "후보나 DOI를 입력하세요.");
          await this.shelf.resolveManually(p.fileId, p.value);
        }
        return this.shelf.fileDetails(p.fileId);
      }
      case "shelfLink": {
        const p = schemas.shelfLink.parse(args);
        this.db.project(p.projectId);
        this.shelf.attachTo(p.fileId, p.workId);
        return;
      }
      case "shelfFilePath":
        return this.shelf.filePath(String(args.fileId));
      case "shelfSortState":
        return this.sorter.view();
      case "shelfSortStart":
        return this.sorter.start(schemas.shelfSortStart.parse(args));
      case "shelfSortCancel":
        this.sorter.cancel();
        return;
      case "shelfSortApply":
        return this.sorter.apply(schemas.shelfSortApply.parse(args).items);
      case "shutdown":
        this.downloads.stopRecoveryMonitor();
        this.shelf.stop();
        this.sorter.cancel();
        this.chat.close();
        this.codex.close();
        this.claude.close();
        this.genealogy.close();
        for (const control of [
          ...this.discovery.active.values(),
          ...this.pdf.active.values(),
          ...this.downloads.active.values(),
          ...this.classifier.active.values(),
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
