import Database from "./sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  Work,
  WorkView,
  Project,
  Collection,
  SeedProfile,
  Run,
  Evidence,
  LibraryState,
  Filters,
  ListResult,
  Attachment,
  ShelfMembership,
} from "../../shared/types";
import { AppError, defaultState, now } from "../../shared/types";
import {
  normalizeDoi,
  pmidOf,
  normalizeOpenAlex,
  titleSimilarity,
  filterReasons,
  similarityEdges,
} from "../../shared/domain";
import type { ShelfSearchResult } from "../../shared/shelf";
import { citationWarnings, graphNodeIds } from "../../shared/graph";

const SCHEMA = 3;
const ROOT_FOLDER_LABEL: Record<string, string> = { "": "수신함" };
export class Library {
  db: Database;
  /** Title/year hints for search results that match an unresolved shelf file. */
  shelfHints?: (works: Work[]) => Map<string, ShelfMembership>;
  constructor(public root: string) {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "attachments"), { recursive: true });
    this.db = new Database(join(root, "library.sqlite"));
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA) {
      this.db.close();
      throw new AppError(
        "NEWER_SCHEMA",
        "이 라이브러리는 더 새로운 앱에서 만들어졌습니다.",
      );
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS works(id TEXT PRIMARY KEY,data TEXT NOT NULL,citekey TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS identifiers(provider TEXT NOT NULL,value TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES works(id),PRIMARY KEY(provider,value));
      CREATE TABLE IF NOT EXISTS metadata_snapshots(id TEXT PRIMARY KEY,work_id TEXT REFERENCES works(id),source TEXT,data TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,question TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_works(project_id TEXT REFERENCES projects(id),work_id TEXT REFERENCES works(id),state TEXT NOT NULL,PRIMARY KEY(project_id,work_id));
      CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),name TEXT NOT NULL,parent_id TEXT REFERENCES collections(id));
      CREATE TABLE IF NOT EXISTS collection_works(collection_id TEXT REFERENCES collections(id),work_id TEXT REFERENCES works(id),PRIMARY KEY(collection_id,work_id));
      CREATE TABLE IF NOT EXISTS archive_topics(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,description TEXT NOT NULL,position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_topic_works(project_id TEXT NOT NULL,work_id TEXT NOT NULL,topic_id TEXT NOT NULL REFERENCES archive_topics(id) ON DELETE CASCADE,PRIMARY KEY(project_id,work_id),FOREIGN KEY(project_id,work_id) REFERENCES project_works(project_id,work_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS seed_profiles(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),version INTEGER,data TEXT NOT NULL,UNIQUE(project_id,version));
      CREATE TABLE IF NOT EXISTS citations(citing_id TEXT REFERENCES works(id),cited_external TEXT NOT NULL,PRIMARY KEY(citing_id,cited_external));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(run_id TEXT REFERENCES runs(id),work_id TEXT REFERENCES works(id),evidence TEXT NOT NULL,rank REAL NOT NULL DEFAULT 0,PRIMARY KEY(run_id,work_id));
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,work_id TEXT REFERENCES works(id),data TEXT NOT NULL,UNIQUE(work_id,data));
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,data TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT,kind TEXT,data TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS import_items(id TEXT PRIMARY KEY,run_id TEXT,name TEXT,status TEXT,message TEXT,work_id TEXT);
      CREATE TABLE IF NOT EXISTS export_records(id TEXT PRIMARY KEY,data TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS provider_usage(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT,run_id TEXT,input_tokens INTEGER,output_tokens INTEGER,created_at TEXT);
      CREATE TABLE IF NOT EXISTS merge_history(id INTEGER PRIMARY KEY,data TEXT,revision INTEGER);
      CREATE INDEX IF NOT EXISTS idx_project_work ON project_works(project_id);
      CREATE INDEX IF NOT EXISTS idx_candidates_rank ON candidates(run_id,rank DESC);
      CREATE INDEX IF NOT EXISTS idx_citations_target ON citations(cited_external);
      CREATE INDEX IF NOT EXISTS idx_attachments_work ON attachments(work_id);
      CREATE TABLE IF NOT EXISTS chat_threads(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT NOT NULL,context_key TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_chat_scope ON chat_threads(project_id,work_id,context_key,updated_at);
      CREATE TABLE IF NOT EXISTS chat_contexts(thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,message_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread_id,message_id));
      CREATE TABLE IF NOT EXISTS chat_heads(scope TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS shelf_roots(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,exclude TEXT NOT NULL,created_at TEXT NOT NULL,last_scan_at TEXT);
      CREATE TABLE IF NOT EXISTS shelf_folders(id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES shelf_roots(id) ON DELETE CASCADE,rel_path TEXT NOT NULL,parent_id TEXT,name TEXT NOT NULL,present INTEGER NOT NULL DEFAULT 1,UNIQUE(root_id,rel_path));
      CREATE TABLE IF NOT EXISTS shelf_files(id TEXT PRIMARY KEY,root_id TEXT NOT NULL REFERENCES shelf_roots(id) ON DELETE CASCADE,folder_id TEXT NOT NULL REFERENCES shelf_folders(id),rel_path TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,hash TEXT,hashed_size INTEGER,hashed_mtime INTEGER,work_id TEXT REFERENCES works(id),attachment_id TEXT,stage TEXT NOT NULL,status TEXT NOT NULL,info TEXT NOT NULL,seen_at TEXT NOT NULL,missing_since TEXT,UNIQUE(root_id,rel_path));
      CREATE INDEX IF NOT EXISTS idx_shelf_files_folder ON shelf_files(folder_id);
      CREATE INDEX IF NOT EXISTS idx_shelf_files_hash ON shelf_files(hash);
      CREATE INDEX IF NOT EXISTS idx_shelf_files_work ON shelf_files(work_id);
      CREATE INDEX IF NOT EXISTS idx_shelf_files_stage ON shelf_files(stage,status);
      -- Attachments made from a shelf file (its own and project links) follow moves and folder changes.
      CREATE INDEX IF NOT EXISTS idx_attachments_shelf ON attachments(json_extract(data,'$.shelfFileId'));
      -- Removing shelf works checks every table that references works(id); without these, each delete scans them.
      CREATE INDEX IF NOT EXISTS idx_identifiers_work ON identifiers(work_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_work ON metadata_snapshots(work_id);
      CREATE INDEX IF NOT EXISTS idx_candidates_work ON candidates(work_id);
      CREATE INDEX IF NOT EXISTS idx_project_works_work ON project_works(work_id);
      CREATE INDEX IF NOT EXISTS idx_collection_works_work ON collection_works(work_id);
      CREATE TABLE IF NOT EXISTS work_embeddings(work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,model TEXT NOT NULL,prompt TEXT NOT NULL,basis TEXT NOT NULL,text_hash TEXT NOT NULL,dim INTEGER NOT NULL,vector BLOB NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(work_id,model));
      CREATE TABLE IF NOT EXISTS embedding_cache(key TEXT PRIMARY KEY,model TEXT NOT NULL,vector BLOB NOT NULL,used_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS shelf_fts USING fts5(work_id UNINDEXED,title,authors,abstract,venue,tokenize='unicode61 remove_diacritics 2');
      PRAGMA user_version=3;
    `);
    if (!this.projects().length) this.createProject("내 연구", "");
    for (const run of this.runs())
      if (["running", "queued"].includes(run.status)) {
        run.status = "interrupted";
        run.message =
          "앱 종료로 중단되었습니다. 저장된 지점에서 재개할 수 있습니다.";
        this.saveRun(run);
      }
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  touch() {
    this.pref("revision", (this.pref<number>("revision") || 0) + 1);
  }
  pref<T = unknown>(key: string, value?: T): T | undefined {
    if (value !== undefined) {
      this.db
        .prepare("INSERT OR REPLACE INTO preferences VALUES(?,?)")
        .run(key, JSON.stringify(value));
      return value;
    }
    const row = this.db
      .prepare("SELECT data FROM preferences WHERE key=?")
      .get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  projects(): Project[] {
    return this.db
      .prepare(
        "SELECT id,name,question,created_at AS createdAt FROM projects ORDER BY created_at",
      )
      .all() as Project[];
  }
  project(id: string): Project {
    const p = this.projects().find((x) => x.id === id);
    if (!p) throw new AppError("NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    return p;
  }
  createProject(name: string, question: string): Project {
    const p = { id: randomUUID(), name, question, createdAt: now() };
    this.db
      .prepare("INSERT INTO projects VALUES(@id,@name,@question,@createdAt)")
      .run(p);
    this.touch();
    return p;
  }
  collections(projectId: string): Collection[] {
    return this.db
      .prepare(
        `SELECT c.id,c.project_id AS projectId,c.name,c.parent_id AS parentId,(SELECT count(*) FROM collection_works cw JOIN project_works pw ON pw.work_id=cw.work_id AND pw.project_id=c.project_id WHERE cw.collection_id=c.id AND json_extract(pw.state,'$.screening')!='trash') AS count FROM collections c WHERE project_id=? ORDER BY name`,
      )
      .all(projectId) as Collection[];
  }
  createCollection(
    projectId: string,
    name: string,
    parentId: string | null = null,
  ): Collection {
    this.project(projectId);
    if (parentId && !this.collections(projectId).some((c) => c.id === parentId))
      throw new AppError("INVALID", "상위 컬렉션이 다른 프로젝트에 있습니다.");
    const c = { id: randomUUID(), projectId, name, parentId, count: 0 };
    this.db
      .prepare("INSERT INTO collections VALUES(@id,@projectId,@name,@parentId)")
      .run(c);
    this.touch();
    return c;
  }
  get(id: string): Work {
    const row = this.db.prepare("SELECT data FROM works WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", "문헌을 찾을 수 없습니다.");
    const work: Work = JSON.parse(row.data);
    return { ...work, pmid: pmidOf(work) };
  }
  findIdentifier(provider: string, value: string): string | undefined {
    return (
      this.db
        .prepare("SELECT work_id FROM identifiers WHERE provider=? AND value=?")
        .get(provider, value) as { work_id: string } | undefined
    )?.work_id;
  }
  identities(w: Work): [string, string][] {
    const keys: [string, string][] = [];
    const pmid = pmidOf(w);
    if (pmid) keys.push(["pmid", pmid]);
    if (w.doi) keys.push(["doi", w.doi]);
    if (w.openalex) keys.push(["openalex", w.openalex]);
    if (w.source === "bibtex")
      keys.push([
        "bibtex",
        createHash("sha256")
          .update(JSON.stringify([w.title, w.authors, w.year, w.doi]))
          .digest("hex"),
      ]);
    return keys;
  }
  match(w: Work): { id?: string; conflict?: string } {
    const found = [
      ...new Set(
        this.identities(w)
          .map(([p, v]) => this.findIdentifier(p, v))
          .filter(Boolean),
      ),
    ] as string[];
    if (found.length > 1)
      return {
        conflict:
          "식별자가 서로 다른 두 문헌을 가리킵니다. 중복 검토에서 병합하세요.",
      };
    if (found.length) {
      const old = this.get(found[0]);
      const snapshot = this.db
        .prepare(
          "SELECT data FROM metadata_snapshots WHERE work_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(old.id) as { data: string } | undefined;
      const originalTitle = snapshot
        ? (JSON.parse(snapshot.data) as Work).title
        : old.title;
      if (
        originalTitle !== "제목 미확인" &&
        w.title !== "제목 미확인" &&
        titleSimilarity(originalTitle, w.title) < 0.12
      )
        return {
          conflict: "식별자는 같지만 제목이 다릅니다. 원문을 확인하세요.",
        };
      return { id: found[0] };
    }
    return {};
  }
  upsert(incoming: Work): { work: Work; existing: boolean } {
    return this.transaction(() => {
      incoming = {
        ...incoming,
        doi: normalizeDoi(incoming.doi),
        pmid: pmidOf(incoming),
        openalex: normalizeOpenAlex(incoming.openalex),
      };
      const match = this.match(incoming);
      if (match.conflict)
        throw new AppError("IDENTITY_CONFLICT", match.conflict);
      const old = match.id ? this.get(match.id) : null;
      let work: Work = old
        ? {
            ...old,
            ...Object.fromEntries(
              Object.entries(incoming).filter(
                ([, v]) =>
                  v !== null && v !== "" && (!Array.isArray(v) || v.length),
              ),
            ),
            id: old.id,
            citekey: old.citekey,
            edits: old.edits,
            bibFields: { ...old.bibFields, ...incoming.bibFields },
            originalBib: old.originalBib || incoming.originalBib,
          }
        : incoming;
      if (old && incoming.source === "bibtex") {
        work = {
          ...work,
          openalex: old.openalex || work.openalex,
          references: old.references,
          related: old.related,
          citations: old.citations,
          topics: old.topics,
          abstract: old.abstract || work.abstract,
        };
      }
      work = { ...work, ...work.edits } as Work;
      if (!work.citekey)
        work.citekey = `${(work.authors[0] || "Anon").split(/[ ,]+/)[0].replace(/[^\p{L}\p{N}]/gu, "") || "Work"}${work.year || "nd"}${work.title.match(/[A-Za-z]{3,}/)?.[0] || "Paper"}`;
      const base = work.citekey.replace(/[^\p{L}\p{N}_:.-]/gu, "") || "Work";
      let key = base,
        n = 1;
      while (
        this.db
          .prepare("SELECT 1 FROM works WHERE citekey=? AND id!=?")
          .get(key, work.id)
      )
        key = `${base}_${n++}`;
      work.citekey = key;
      this.db
        .prepare(
          "INSERT INTO works VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,citekey=excluded.citekey",
        )
        .run(work.id, JSON.stringify(work), work.citekey);
      for (const [p, v] of this.identities(work))
        this.db
          .prepare("INSERT OR IGNORE INTO identifiers VALUES(?,?,?)")
          .run(p, v, work.id);
      this.db
        .prepare("INSERT INTO metadata_snapshots VALUES(?,?,?,?,?)")
        .run(
          randomUUID(),
          work.id,
          incoming.source,
          JSON.stringify(incoming),
          now(),
        );
      if (work.references)
        for (const external of work.references)
          this.db
            .prepare("INSERT OR IGNORE INTO citations VALUES(?,?)")
            .run(work.id, external);
      this.touch();
      return { work, existing: !!old };
    });
  }
  ensureMembership(projectId: string, workId: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO project_works VALUES(?,?,?)")
      .run(projectId, workId, JSON.stringify(defaultState()));
  }
  state(projectId: string, workId: string): LibraryState {
    const row = this.db
      .prepare(
        "SELECT state FROM project_works WHERE project_id=? AND work_id=?",
      )
      .get(projectId, workId) as { state: string } | undefined;
    return row ? { pendingDismissed: false, ...JSON.parse(row.state) } : defaultState();
  }
  view(projectId: string, id: string, runId?: string): WorkView {
    this.get(id);
    return this.views(projectId, [id], runId)[0];
  }
  /** Build list rows with one query per related table instead of four per work. */
  views(projectId: string, ids: string[], runId?: string): WorkView[] {
    if (!ids.length) return [];
    const list = JSON.stringify(ids);
    const inIds = "SELECT value FROM json_each(?)";
    const works = new Map(
      (this.db.prepare(`SELECT id,data FROM works WHERE id IN (${inIds})`).all(list) as { id: string; data: string }[])
        .map((r) => {
          const work: Work = JSON.parse(r.data);
          return [r.id, { ...work, pmid: pmidOf(work) }] as const;
        }),
    );
    const states = new Map(
      (this.db.prepare(`SELECT work_id AS id,state FROM project_works WHERE project_id=? AND work_id IN (${inIds})`).all(projectId, list) as { id: string; state: string }[])
        .map((r) => [r.id, r.state]),
    );
    const topics = new Map(
      (this.db.prepare(`SELECT work_id AS id,topic_id FROM archive_topic_works WHERE project_id=? AND work_id IN (${inIds})`).all(projectId, list) as { id: string; topic_id: string }[])
        .map((r) => [r.id, r.topic_id]),
    );
    const evidence = new Map(
      runId
        ? (this.db.prepare(`SELECT work_id AS id,evidence FROM candidates WHERE run_id=? AND work_id IN (${inIds})`).all(runId, list) as { id: string; evidence: string }[])
            .map((r) => [r.id, r.evidence])
        : [],
    );
    const attachments = new Map(
      (this.db.prepare(`SELECT work_id AS id,count(*) AS n FROM attachments WHERE work_id IN (${inIds}) GROUP BY work_id`).all(list) as { id: string; n: number }[])
        .map((r) => [r.id, r.n]),
    );
    const collections = new Map<string, string[]>();
    for (const r of this.db.prepare(`SELECT work_id AS id,collection_id FROM collection_works WHERE work_id IN (${inIds})`).all(list) as { id: string; collection_id: string }[])
      collections.set(r.id, [...(collections.get(r.id) || []), r.collection_id]);
    const shelf = this.shelfMemberships(ids);
    const result: WorkView[] = [];
    for (const id of ids) {
      const w = works.get(id);
      if (!w) continue;
      const state = states.get(id);
      result.push({
        ...w,
        state: state ? { pendingDismissed: false, ...JSON.parse(state) } : defaultState(),
        archiveTopicId: topics.get(id),
        evidence: evidence.has(id) ? JSON.parse(evidence.get(id)!) : undefined,
        attachmentCount: attachments.get(id) || 0,
        collectionIds: collections.get(id) || [],
        ...(shelf.has(id) ? { shelf: shelf.get(id) } : {}),
      });
    }
    return result;
  }
  shelfMemberships(ids: string[]): Map<string, ShelfMembership> {
    const map = new Map<string, ShelfMembership>();
    if (!ids.length) return map;
    const rows = this.db.prepare(
      `SELECT f.work_id,f.id,f.folder_id,fo.rel_path AS folder,f.rel_path,r.path AS root,f.status,f.stage,
        (SELECT count(*) FROM shelf_files c WHERE c.work_id=f.work_id AND c.status!='missing') AS copies
       FROM shelf_files f JOIN shelf_folders fo ON fo.id=f.folder_id JOIN shelf_roots r ON r.id=f.root_id
       WHERE f.work_id IN (SELECT value FROM json_each(?))
       ORDER BY f.status='missing',json_extract(f.info,'$.duplicateOf') IS NOT NULL,f.rel_path`,
    ).all(JSON.stringify(ids)) as { work_id: string; id: string; folder_id: string; folder: string; rel_path: string; root: string; status: string; stage: string; copies: number }[];
    for (const r of rows)
      if (!map.has(r.work_id))
        map.set(r.work_id, {
          fileId: r.id,
          folderId: r.folder_id,
          folder: ROOT_FOLDER_LABEL[r.folder] ?? r.folder,
          path: join(r.root, r.rel_path),
          status: r.status,
          stage: r.stage,
          copies: r.copies,
          match: "identity",
        });
    return map;
  }
  mutate(
    projectId: string,
    ids: string[],
    patch: Partial<LibraryState>,
    record = true,
  ) {
    this.transaction(() => {
      this.project(projectId);
      const before = ids.map((id) => ({
        id,
        state: this.state(projectId, id),
      }));
      for (const { id, state } of before) {
        this.get(id);
        this.ensureMembership(projectId, id);
        const next = { ...state, ...patch, updatedAt: now() };
        if (patch.screening === "pending" && patch.pendingDismissed === undefined)
          next.pendingDismissed = false;
        if (patch.screening === "trash")
          next.previousScreening = state.screening;
        this.db
          .prepare(
            "UPDATE project_works SET state=? WHERE project_id=? AND work_id=?",
          )
          .run(JSON.stringify(next), projectId, id);
      }
      if (record)
        this.db
          .prepare(
            "INSERT INTO changes(project_id,kind,data,created_at) VALUES(?,?,?,?)",
          )
          .run(projectId, "state", JSON.stringify(before), now());
      this.touch();
    });
  }
  clearPending(projectId: string): { ids: string[] } {
    return this.transaction(() => {
      this.project(projectId);
      const rows = this.db.prepare(
        "SELECT work_id AS id FROM project_works WHERE project_id=? AND json_extract(state,'$.screening')='pending' AND coalesce(json_extract(state,'$.pendingDismissed'),0)=0",
      ).all(projectId) as { id: string }[];
      const ids = rows.map(row => row.id);
      if (ids.length) this.mutate(projectId, ids, { pendingDismissed: true });
      return { ids };
    });
  }
  undo(projectId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT * FROM changes WHERE project_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(projectId) as { id: number; kind: string; data: string } | undefined;
    if (!row) return false;
    this.transaction(() => {
      for (const item of JSON.parse(row.data))
        this.mutate(projectId, [item.id], { pendingDismissed: false, ...item.state }, false);
      this.db.prepare("DELETE FROM changes WHERE id=?").run(row.id);
    });
    return true;
  }
  edit(id: string, patch: Partial<Work>): Work {
    return this.transaction(() => {
      const work = this.get(id);
      if ("doi" in patch) {
        const doi = normalizeDoi(patch.doi);
        if (patch.doi && !doi)
          throw new AppError("INVALID_DOI", "DOI 형식을 확인하세요.");
        const duplicate = doi && this.findIdentifier("doi", doi);
        if (duplicate && duplicate !== id)
          throw new AppError(
            "DUPLICATE",
            "이 DOI의 문헌이 이미 있습니다. 중복 검토에서 병합하세요.",
          );
        patch.doi = doi;
        if (doi)
          this.db
            .prepare("INSERT OR IGNORE INTO identifiers VALUES(?,?,?)")
            .run("doi", doi, id);
      }
      const updated = { ...work, ...patch, edits: { ...work.edits, ...patch } };
      this.db
        .prepare("UPDATE works SET data=? WHERE id=?")
        .run(JSON.stringify(updated), id);
      this.touch();
      return updated;
    });
  }
  setSeeds(
    projectId: string,
    ids: string[],
    question: string,
    groups: Record<string, string[]>,
  ): SeedProfile {
    return this.transaction(() => {
      this.project(projectId);
      for (const id of ids) this.get(id);
      const latest = this.seedHistory(projectId)[0];
      const seed = {
        id: randomUUID(),
        projectId,
        version: (latest?.version || 0) + 1,
        question,
        ids: [...new Set(ids)],
        groups,
        createdAt: now(),
      };
      this.db
        .prepare("INSERT INTO seed_profiles VALUES(?,?,?,?)")
        .run(seed.id, projectId, seed.version, JSON.stringify(seed));
      this.db
        .prepare("UPDATE projects SET question=? WHERE id=?")
        .run(question, projectId);
      this.touch();
      return seed;
    });
  }
  seedHistory(projectId: string): SeedProfile[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM seed_profiles WHERE project_id=? ORDER BY version DESC",
        )
        .all(projectId) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  seedById(id: string | null): SeedProfile | null {
    if (!id) return null;
    const r = this.db
      .prepare("SELECT data FROM seed_profiles WHERE id=?")
      .get(id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  saveRun(run: Run) {
    run.updatedAt = now();
    this.db
      .prepare(
        "INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(run.id, run.projectId, JSON.stringify(run));
  }
  run(id: string): Run {
    const r = this.db.prepare("SELECT data FROM runs WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!r) throw new AppError("NOT_FOUND", "탐색 기록을 찾을 수 없습니다.");
    return JSON.parse(r.data);
  }
  runs(projectId?: string): Run[] {
    return (
      this.db
        .prepare(
          `SELECT data FROM runs ${projectId ? "WHERE project_id=?" : ""} ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 100`,
        )
        .all(...(projectId ? [projectId] : [])) as { data: string }[]
    ).map((x) => JSON.parse(x.data));
  }
  candidate(run: Run, work: Work, evidence: Evidence) {
    const old = this.db
      .prepare("SELECT evidence FROM candidates WHERE run_id=? AND work_id=?")
      .get(run.id, work.id) as { evidence: string } | undefined;
    if (old) {
      const prev = JSON.parse(old.evidence) as Evidence;
      evidence = {
        ...prev,
        origins: [...new Set([...prev.origins, ...evidence.origins])],
        seedIds: [...new Set([...prev.seedIds, ...evidence.seedIds])],
        sharedIds: [...new Set([...prev.sharedIds, ...evidence.sharedIds])],
      };
    }
    this.db
      .prepare(
        "INSERT INTO candidates VALUES(?,?,?,?) ON CONFLICT(run_id,work_id) DO UPDATE SET evidence=excluded.evidence,rank=excluded.rank",
      )
      .run(run.id, work.id, JSON.stringify(evidence), evidence.score || 0);
    this.ensureMembership(run.projectId, work.id);
    // Rediscovery queues a dismissed candidate again without changing screening decisions.
    this.db.prepare(
      "UPDATE project_works SET state=json_set(state,'$.pendingDismissed',json('false')) WHERE project_id=? AND work_id=? AND json_extract(state,'$.screening')='pending' AND json_extract(state,'$.pendingDismissed')=1",
    ).run(run.projectId, work.id);
  }
  candidates(runId: string): { work: Work; evidence: Evidence }[] {
    return (
      this.db
        .prepare(
          "SELECT w.data,c.evidence FROM candidates c JOIN works w ON w.id=c.work_id WHERE run_id=? ORDER BY rank DESC",
        )
        .all(runId) as { data: string; evidence: string }[]
    ).map((r) => ({
      work: JSON.parse(r.data),
      evidence: JSON.parse(r.evidence),
    }));
  }
  updateEvidence(runId: string, id: string, evidence: Evidence, rank: number) {
    this.db
      .prepare(
        "UPDATE candidates SET evidence=?,rank=? WHERE run_id=? AND work_id=?",
      )
      .run(JSON.stringify(evidence), rank, runId, id);
  }
  edges(ids: string[]): { source: string; target: string }[] {
    if (!ids.length) return [];
    // Walk out from the listed papers' own references. Left to itself, SQLite drives this
    // from every OpenAlex identifier and probes each listed id: seconds for a whole shelf.
    return this.db
      .prepare(
        "WITH listed(id) AS MATERIALIZED (SELECT DISTINCT value FROM json_each(?)) SELECT DISTINCT c.citing_id AS source,i.work_id AS target FROM listed s CROSS JOIN citations c ON c.citing_id=s.id CROSS JOIN identifiers i ON i.provider='openalex' AND i.value=c.cited_external WHERE i.work_id IN listed AND i.work_id!=c.citing_id",
      )
      .all(JSON.stringify(ids)) as { source: string; target: string }[];
  }
  /** Shelf work ids for a folder (with descendants) or a virtual shelf folder. */
  shelfScope(scopeId: string): string[] {
    const visible = "f.work_id IS NOT NULL AND f.status!='missing'";
    let rows: { id: string }[];
    if (scopeId === "all")
      rows = this.db.prepare(`SELECT DISTINCT f.work_id AS id FROM shelf_files f WHERE ${visible}`).all() as { id: string }[];
    else if (scopeId === "review")
      rows = this.db.prepare(`SELECT DISTINCT f.work_id AS id FROM shelf_files f WHERE ${visible} AND f.stage='resolved' AND f.status IN ('review','provisional')`).all() as { id: string }[];
    else if (scopeId === "inbox")
      rows = this.db.prepare(
        `SELECT DISTINCT f.work_id AS id FROM shelf_files f JOIN shelf_folders fo ON fo.id=f.folder_id WHERE ${visible} AND fo.rel_path=''`,
      ).all() as { id: string }[];
    else {
      const folder = this.db.prepare("SELECT root_id,rel_path FROM shelf_folders WHERE id=?").get(scopeId) as { root_id: string; rel_path: string } | undefined;
      if (!folder) throw new AppError("INVALID", "서고 폴더를 찾을 수 없습니다. 폴더가 사라졌거나 서고 위치가 바뀌었습니다.");
      rows = this.db.prepare(
        `SELECT DISTINCT f.work_id AS id FROM shelf_files f JOIN shelf_folders fo ON fo.id=f.folder_id WHERE ${visible} AND fo.root_id=? AND (fo.rel_path=? OR substr(fo.rel_path,1,length(?)+1)=?||'/')`,
      ).all(folder.root_id, folder.rel_path, folder.rel_path, folder.rel_path) as { id: string }[];
    }
    return rows.map((r) => r.id);
  }
  /** Each work's subfolder directly below a shelf scope; works filed only at its top level have none. */
  shelfSubfolders(scopeId: string, workIds: string[]): Record<string, string> {
    if (!workIds.length) return {};
    const folder = ["all", "inbox", "review"].includes(scopeId)
      ? null
      : (this.db.prepare("SELECT root_id,rel_path FROM shelf_folders WHERE id=?").get(scopeId) as { root_id: string; rel_path: string } | undefined);
    const base = folder?.rel_path ?? "";
    const inside = folder
      ? "fo.root_id=? AND substr(fo.rel_path,1,length(?)+1)=?||'/'"
      : "fo.rel_path!=''";
    const rows = this.db.prepare(
      `SELECT f.work_id AS id,fo.rel_path AS folder FROM shelf_files f JOIN shelf_folders fo ON fo.id=f.folder_id
       WHERE f.status!='missing' AND f.work_id IN (SELECT value FROM json_each(?)) AND ${inside}
       ORDER BY json_extract(f.info,'$.duplicateOf') IS NOT NULL,f.rel_path`,
    ).all(JSON.stringify(workIds), ...(folder ? [folder.root_id, base, base] : [])) as { id: string; folder: string }[];
    const result: Record<string, string> = {};
    for (const { id, folder: path } of rows) {
      if (id in result) continue;
      const rest = base ? path.slice(base.length + 1) : path;
      result[id] = (base ? base + "/" : "") + rest.split("/")[0];
    }
    return result;
  }
  list(args: {
    projectId: string;
    scope: string;
    scopeId?: string;
    query: string;
    filters: Filters;
    showHidden: boolean;
    offset: number;
    limit: number;
    sort: string;
    /** Graphs draw linked papers from the whole scope instead of a list page. */
    graph?: boolean;
  }, search?: ShelfSearchResult): ListResult {
    const { projectId, scope, scopeId } = args;
    let sql =
      "SELECT pw.work_id AS id FROM project_works pw WHERE pw.project_id=?";
    const params: string[] = [projectId];
    if (scope === "run") {
      const run = this.run(scopeId || "");
      if (run.projectId !== projectId)
        throw new AppError("INVALID", "다른 프로젝트의 탐색입니다.");
      sql =
        "SELECT work_id AS id FROM candidates WHERE run_id=? ORDER BY rank DESC";
      params[0] = scopeId || "";
    } else if (scope === "collection") {
      if (!this.collections(projectId).some((c) => c.id === scopeId))
        throw new AppError("INVALID", "컬렉션을 찾을 수 없습니다.");
      sql +=
        " AND work_id IN(SELECT work_id FROM collection_works WHERE collection_id=?) AND json_extract(state,'$.screening')!='trash'";
      params.push(scopeId || "");
    } else if (scope === "topic" || scope === "unclassified") {
      sql += " AND json_extract(state,'$.screening')='included'";
      if (scope === "topic") {
        sql += " AND EXISTS(SELECT 1 FROM archive_topic_works tw JOIN archive_topics t ON t.id=tw.topic_id WHERE tw.project_id=pw.project_id AND tw.work_id=pw.work_id AND t.project_id=pw.project_id AND t.id=?)";
        params.push(scopeId || "");
      } else {
        sql += " AND NOT EXISTS(SELECT 1 FROM archive_topic_works tw WHERE tw.project_id=pw.project_id AND tw.work_id=pw.work_id)";
      }
    } else if (scope === "starred")
      sql +=
        " AND json_extract(state,'$.starred')=1 AND json_extract(state,'$.screening')!='trash'";
    else if (scope === "reading")
      sql +=
        " AND json_extract(state,'$.reading') IN ('planned','reading') AND json_extract(state,'$.screening')!='trash'";
    else {
      sql += " AND json_extract(state,'$.screening')=?";
      params.push(scope === "archive" ? "included" : scope);
      if (scope === "pending")
        sql += " AND coalesce(json_extract(state,'$.pendingDismissed'),0)=0";
    }
    // A shelf search replaces the folder listing with its ranked hits.
    const rows = search
      ? search.hits.map((hit) => ({ id: hit.workId }))
      : scope === "shelf"
        ? this.shelfScope(scopeId || "all").map((id) => ({ id }))
        : (this.db.prepare(sql).all(...params) as { id: string }[]);
    const hits = new Map(search?.hits.map((hit) => [hit.workId, hit]));
    let works = this.views(projectId, rows.map((r) => r.id), scope === "run" ? scopeId : undefined);
    if (scope === "run" && this.shelfHints) {
      const hints = this.shelfHints(works.filter((w) => !w.shelf));
      for (const w of works) if (!w.shelf && hints.has(w.id)) w.shelf = hints.get(w.id);
    }
    if (args.query && !search) {
      const q = args.query.toLowerCase();
      works = works.filter((w) =>
        `${w.title} ${w.authors.join(" ")} ${w.abstract || ""} ${w.citekey} ${w.state.note} ${w.state.tags.join(" ")}`
          .toLowerCase()
          .includes(q),
      );
    }
    let hidden = 0,
      deferred = 0;
    const kept: WorkView[] = [];
    for (const w of works) {
      // Shelf folders and runs list works regardless of project state; trash shows only in its own view.
      if (scope !== "trash" && w.state.screening === "trash") continue;
      const reasons = filterReasons(w, args.filters, w.evidence);
      if (scope === "trash" || scope === "excluded") {
        const i = reasons.indexOf("사용자 제외");
        if (i >= 0) reasons.splice(i, 1);
      }
      const hit = hits.get(w.id);
      if (w.evidence) w.evidence.hidden = reasons;
      else
        w.evidence = {
          origins: [],
          seedIds: [],
          sharedIds: [],
          denominator: 0,
          relation: "local",
          score: hit?.score ?? null,
          reasons: hit
            ? [search?.identifier ? "식별자 일치"
              : hit.semanticRank && hit.lexicalRank ? "의미와 검색어 모두 일치"
              : hit.semanticRank ? "의미가 가까움" : "검색어 일치"]
            : [],
          hidden: reasons,
          deferred: false,
          scope: scope === "shelf" ? "서고" : "로컬 아카이브",
        };
      if (w.evidence.deferred) deferred++;
      if (reasons.length) hidden++;
      if (args.showHidden || !reasons.length) kept.push(w);
    }
    if (scope === "shelf" && args.sort === "rank" && !search)
      kept.sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title));
    // Shelf matches stay in their own pinned group instead of competing on score.
    const pinned = scope === "run"
      ? kept.filter((w) => w.evidence?.relation === "shelf").sort((a, b) => (b.evidence?.shelf?.score ?? 0) - (a.evidence?.shelf?.score ?? 0))
      : [];
    if (pinned.length) kept.splice(0, kept.length, ...kept.filter((w) => w.evidence?.relation !== "shelf"));
    if (args.sort === "year")
      kept.sort((a, b) => (b.year || 0) - (a.year || 0));
    if (args.sort === "citations")
      kept.sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1));
    if (args.sort === "title")
      kept.sort((a, b) => a.title.localeCompare(b.title));
    if (args.sort === "updated")
      kept.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
    const run = scope === "run" && scopeId ? this.run(scopeId) : null;
    const contextIds = run
      ? [
          ...new Set([
            ...run.inputIds,
            ...(this.seedById(run.seedProfileId)?.ids || []),
          ]),
        ]
      : [];
    if (args.graph) {
      const keptIds = new Set(kept.map((w) => w.id));
      const pool = [...kept, ...this.views(projectId, contextIds.filter((id) => !keptIds.has(id)))];
      const citations = this.edges(pool.map((w) => w.id));
      const warnings = citationWarnings(pool, citations);
      // Questionable citations are hidden by default, so they cannot keep a paper on the graph.
      const links = [
        ...citations.filter((e) => !warnings.has(`${e.source}:${e.target}`)),
        ...similarityEdges(pool),
      ];
      const chosen = graphNodeIds([...keptIds], contextIds, links);
      const shown = new Set(chosen.ids), drawn = new Set([...chosen.ids, ...contextIds]);
      const page = kept.filter((w) => shown.has(w.id));
      return {
        works: page,
        context: pool.filter((w) => drawn.has(w.id) && !shown.has(w.id)),
        ...(scope === "run" ? { shelf: pinned } : {}),
        ...(search ? { search: { semantic: search.semantic, identifier: !!search.identifier } } : {}),
        total: kept.length,
        hidden,
        deferred,
        ids: kept.map((w) => w.id),
        edges: citations.filter((e) => drawn.has(e.source) && drawn.has(e.target)),
        graph: { connected: chosen.connected },
        ...(scope === "shelf" ? { subfolders: this.shelfSubfolders(scopeId || "all", page.map((w) => w.id)) } : {}),
      };
    }
    const page = kept.slice(args.offset, args.offset + args.limit);
    const context = this.views(
      projectId,
      contextIds.filter((id) => !page.some((w) => w.id === id)),
    );
    return {
      works: page,
      context,
      ...(scope === "run" ? { shelf: pinned } : {}),
      ...(search ? { search: { semantic: search.semantic, identifier: !!search.identifier } } : {}),
      total: kept.length,
      hidden,
      deferred,
      ids: kept.map((w) => w.id),
      edges: this.edges([...page.map((w) => w.id), ...contextIds]),
    };
  }
  attachments(workId: string): Attachment[] {
    return (
      this.db
        .prepare("SELECT data FROM attachments WHERE work_id=?")
        .all(workId) as { data: string }[]
    ).map((r) => {
      const a = JSON.parse(r.data);
      return { ...a, exists: existsSync(a.path) };
    });
  }
  attachment(id: string): Attachment {
    const r = this.db
      .prepare("SELECT data FROM attachments WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!r) throw new AppError("NOT_FOUND", "첨부를 찾을 수 없습니다.");
    return JSON.parse(r.data);
  }
  saveAttachment(a: Attachment) {
    this.db
      .prepare(
        "INSERT INTO attachments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,work_id=excluded.work_id",
      )
      .run(a.id, a.workId, JSON.stringify(a));
    this.touch();
  }
  counts(projectId: string): Record<string, number> {
    const count: Record<string, number> = {
      archive: 0,
      pending: 0,
      starred: 0,
      reading: 0,
      trash: 0,
      excluded: 0,
    };
    for (const r of this.db
      .prepare("SELECT state FROM project_works WHERE project_id=?")
      .all(projectId) as { state: string }[]) {
      const s = JSON.parse(r.state) as LibraryState;
      const k = s.screening === "included" ? "archive" : s.screening;
      if (k !== "pending" || !s.pendingDismissed) count[k]++;
      if (s.screening !== "trash") {
        if (s.starred) count.starred++;
        if (["planned", "reading"].includes(s.reading)) count.reading++;
      }
    }
    return count;
  }
  cacheGet(key: string): unknown | undefined {
    const r = this.db
      .prepare("SELECT data FROM cache WHERE key=? AND expires>?")
      .get(key, Date.now()) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  cacheSet(key: string, value: unknown, ttl: number) {
    this.db
      .prepare("INSERT OR REPLACE INTO cache VALUES(?,?,?)")
      .run(key, JSON.stringify(value), Date.now() + ttl);
  }
  usage(provider: string, runId: string, inputTokens = 0, outputTokens = 0) {
    this.db
      .prepare(
        "INSERT INTO provider_usage(provider,run_id,input_tokens,output_tokens,created_at) VALUES(?,?,?,?,?)",
      )
      .run(provider, runId, inputTokens, outputTokens, now());
  }
  usageSummary() {
    return this.db
      .prepare(
        "SELECT provider,count(*) AS calls,sum(input_tokens) AS inputTokens,sum(output_tokens) AS outputTokens FROM provider_usage GROUP BY provider",
      )
      .all() as {
      provider: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
    }[];
  }
}
