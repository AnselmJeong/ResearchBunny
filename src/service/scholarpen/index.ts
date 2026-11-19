import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Library } from "../db/database";
import { AppError, now, type AppEvent, type Project } from "../../shared/types";
import {
  LINK_DIR,
  LINK_FILES,
  LINK_FORMAT,
  type LinkedArchiveFile,
  type LinkedProjectFile,
  type LinkedWork,
  type ScholarPenState,
} from "../../shared/scholarpen";
import type { ScreeningStore } from "../screening/store";
import type { EvidenceTables } from "../evidence";
import { parseBib } from "../interchange/bibtex";

const ROOT_KEY = "scholarpen:root";
/** References ScholarPen keeps for a project, newest location first. */
const REFERENCE_FILES = [join("exports", "references.bib"), "references.bib"];

export interface LinkDeps {
  db: Library;
  screening: ScreeningStore;
  evidence: Pick<EvidenceTables, "render" | "targetIds">;
  /** Works whose PDF passages are indexed. */
  indexed: (ids: string[]) => Set<string>;
  emit: (event: AppEvent) => void;
}

/** A folder name under the root: one path segment, not hidden. */
function folderName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith(".") || /[/\\]/.test(trimmed) || trimmed === "..")
    throw new AppError("INVALID", "폴더 이름을 확인하세요. 점으로 시작하거나 경로 구분자가 들어간 이름은 쓸 수 없습니다.");
  return trimmed;
}

/** Writes through a temporary file in the same folder, and only when the content changed. */
async function writeIfChanged(path: string, text: string, same: (old: string) => boolean = (old) => old === text) {
  const old = await readFile(path, "utf8").catch(() => null);
  if (old !== null && same(old)) return false;
  const staging = join(resolve(path, ".."), `.${basename(path)}.${randomUUID().slice(0, 8)}.tmp`);
  await writeFile(staging, text);
  await rename(staging, path);
  return true;
}
const withoutTime = (text: string) => {
  try {
    const { updatedAt: _ignored, ...rest } = JSON.parse(text) as { updatedAt?: string };
    return JSON.stringify(rest);
  } catch {
    return text;
  }
};

/** Links projects to ScholarPen folders and keeps the linked folders' ResearchBunny files current. */
export class ScholarPenLinks {
  private timer?: ReturnType<typeof setInterval>;
  private lastRevision = -1;
  private syncing = false;
  private synced: ScholarPenState["synced"] = {};
  constructor(private deps: LinkDeps) {}

  root(): string | null {
    return this.deps.db.pref<string>(ROOT_KEY) || null;
  }
  configure(path: string | null) {
    if (path) {
      const full = resolve(path);
      if (!existsSync(full) || !statSync(full).isDirectory()) throw new AppError("INVALID", "공유 폴더를 찾을 수 없습니다.");
      this.deps.db.pref(ROOT_KEY, full);
    } else this.deps.db.db.prepare("DELETE FROM preferences WHERE key=?").run(ROOT_KEY);
    this.lastRevision = -1;
    return this.state();
  }
  links(): Map<string, string> {
    return new Map((this.deps.db.db.prepare("SELECT project_id,folder FROM project_links").all() as { project_id: string; folder: string }[]).map((r) => [r.project_id, r.folder]));
  }
  linkedFolder(projectId: string): string | null {
    const root = this.root();
    const folder = this.links().get(projectId);
    return root && folder ? join(root, folder) : null;
  }

  async state(): Promise<ScholarPenState> {
    const root = this.root();
    const links = this.links();
    const byFolder = new Map([...links].map(([projectId, folder]) => [folder, projectId]));
    if (!root) return { root: null, online: false, folders: [], links: Object.fromEntries(links), synced: this.synced };
    let entries: { name: string; isDirectory: () => boolean }[] = [];
    let online = true;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      online = false;
    }
    const folders = entries
      // Every folder ScholarPen does not hide is one of its projects.
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        path: join(root, e.name),
        projectId: byFolder.get(e.name) ?? null,
        hasReferences: REFERENCE_FILES.some((f) => existsSync(join(root, e.name, f))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { root, online, folders, links: Object.fromEntries(links), synced: this.synced };
  }

  /** Links a project to a folder under the root, making the folder when asked; null unlinks. Files already written stay. */
  async link(projectId: string, folder: string | null, create = false) {
    this.deps.db.project(projectId);
    if (folder === null) {
      this.deps.db.db.prepare("DELETE FROM project_links WHERE project_id=?").run(projectId);
      return this.state();
    }
    const root = this.root();
    if (!root) throw new AppError("SCHOLARPEN_ROOT", "설정에서 ScholarPen 공유 폴더를 먼저 고르세요.");
    const name = folderName(folder);
    const path = join(root, name);
    if (create) {
      if (existsSync(path)) throw new AppError("EXISTS", `‘${name}’ 폴더가 이미 있습니다. 기존 폴더 연결을 고르세요.`);
      await mkdir(path);
    } else if (!existsSync(path)) throw new AppError("NOT_FOUND", `‘${name}’ 폴더를 찾을 수 없습니다.`);
    const owner = this.deps.db.db.prepare("SELECT project_id FROM project_links WHERE folder=?").get(name) as { project_id: string } | undefined;
    if (owner && owner.project_id !== projectId)
      throw new AppError("LINKED", `‘${name}’ 폴더는 이미 ‘${this.deps.db.project(owner.project_id).name}’ 프로젝트에 연결되어 있습니다.`);
    this.deps.db.db.prepare("INSERT INTO project_links VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET folder=excluded.folder").run(projectId, name);
    await this.sync(projectId);
    return this.state();
  }

  /**
   * A ResearchBunny project for a ScholarPen folder that has none: named after
   * the folder, linked to it, and with its references.bib in the archive.
   */
  async createFromFolder(folder: string): Promise<{ project: Project; imported: number; failed: number; withoutPdf: string[] }> {
    const root = this.root();
    if (!root) throw new AppError("SCHOLARPEN_ROOT", "설정에서 ScholarPen 공유 폴더를 먼저 고르세요.");
    const name = folderName(folder);
    const path = join(root, name);
    if (!existsSync(path)) throw new AppError("NOT_FOUND", `‘${name}’ 폴더를 찾을 수 없습니다.`);
    if (this.deps.db.db.prepare("SELECT 1 FROM project_links WHERE folder=?").get(name))
      throw new AppError("LINKED", `‘${name}’ 폴더는 이미 프로젝트에 연결되어 있습니다.`);
    let bib = "";
    for (const file of REFERENCE_FILES) {
      bib = await readFile(join(path, file), "utf8").catch(() => "");
      if (bib) break;
    }
    const db = this.deps.db;
    const entries = bib ? parseBib(bib) : [];
    let imported = 0, failed = 0;
    const ids: string[] = [];
    const project = db.transaction(() => {
      const created = db.createProject(name.slice(0, 160), "");
      for (const entry of entries) {
        if (!entry.work) {
          failed++;
          continue;
        }
        try {
          const { work } = db.upsert(entry.work);
          db.ensureMembership(created.id, work.id);
          ids.push(work.id);
          imported++;
        } catch {
          failed++;
        }
      }
      if (ids.length) db.mutate(created.id, ids, { screening: "included" }, false);
      db.db.prepare("INSERT INTO project_links VALUES(?,?)").run(created.id, name);
      return created;
    });
    const withPdf = new Set(
      (db.db.prepare("SELECT DISTINCT work_id AS id FROM attachments WHERE work_id IN (SELECT value FROM json_each(?)) UNION SELECT DISTINCT work_id FROM shelf_files WHERE status!='missing' AND work_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids), JSON.stringify(ids)) as { id: string }[]).map((r) => r.id),
    );
    await this.sync(project.id).catch(() => {});
    return { project, imported, failed, withoutPdf: ids.filter((id) => !withPdf.has(id)) };
  }

  private projectFile(projectId: string): LinkedProjectFile {
    const project = this.deps.db.project(projectId);
    const profile = this.deps.screening.profile(projectId);
    return {
      format: LINK_FORMAT,
      app: "ResearchBunny",
      projectId,
      name: project.name,
      question: project.question,
      screening: {
        purpose: profile.purpose,
        intent: profile.intent,
        include: profile.include.map((c) => c.text),
        exclude: profile.exclude.map((c) => c.text),
        version: profile.version,
      },
      updatedAt: now(),
    };
  }
  private archiveFile(projectId: string): LinkedArchiveFile {
    const db = this.deps.db.db;
    const rows = db.prepare(
      `SELECT w.id,w.data FROM project_works pw JOIN works w ON w.id=pw.work_id
       WHERE pw.project_id=? AND json_extract(pw.state,'$.screening')='included' ORDER BY w.id`,
    ).all(projectId) as { id: string; data: string }[];
    const ids = rows.map((r) => r.id);
    const list = JSON.stringify(ids);
    const collections = new Map<string, string[]>();
    for (const r of db.prepare("SELECT cw.work_id AS id,c.name FROM collection_works cw JOIN collections c ON c.id=cw.collection_id WHERE c.project_id=? AND cw.work_id IN (SELECT value FROM json_each(?)) ORDER BY c.name").all(projectId, list) as { id: string; name: string }[])
      collections.set(r.id, [...(collections.get(r.id) || []), r.name]);
    const topics = new Map((db.prepare("SELECT tw.work_id AS id,t.name FROM archive_topic_works tw JOIN archive_topics t ON t.id=tw.topic_id WHERE tw.project_id=?").all(projectId) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
    const pdfs = new Set((db.prepare("SELECT DISTINCT work_id AS id FROM attachments WHERE work_id IN (SELECT value FROM json_each(?)) UNION SELECT DISTINCT work_id FROM shelf_files WHERE status!='missing' AND work_id IN (SELECT value FROM json_each(?))").all(list, list) as { id: string }[]).map((r) => r.id));
    const indexed = this.deps.indexed(ids);
    const characters = this.deps.screening.characters(ids);
    const works: LinkedWork[] = rows.map((r) => {
      const w = JSON.parse(r.data) as { title: string; doi: string | null; pmid: string | null; authors: string[]; year: number | null; venue: string; raw?: { ids?: { pmid?: string } } };
      const c = characters.get(r.id);
      return {
        id: r.id,
        doi: w.doi,
        pmid: w.pmid ?? (typeof w.raw?.ids?.pmid === "string" ? w.raw.ids.pmid.replace(/\D/g, "") || null : null),
        title: w.title,
        authors: w.authors.slice(0, 8),
        year: w.year,
        venue: w.venue,
        type: c?.type ?? null,
        contributions: c?.contributions ?? [],
        collections: collections.get(r.id) || [],
        topic: topics.get(r.id) ?? null,
        pdf: pdfs.has(r.id),
        indexed: indexed.has(r.id),
      };
    });
    return { format: LINK_FORMAT, projectId, updatedAt: now(), works };
  }

  /** Writes the linked folder's ResearchBunny files; only files whose content changed are written. */
  async sync(projectId: string): Promise<{ written: string[] }> {
    const folder = this.linkedFolder(projectId);
    if (!folder) throw new AppError("NOT_LINKED", "이 프로젝트에 연결된 ScholarPen 폴더가 없습니다.");
    const written: string[] = [];
    try {
      if (!existsSync(folder)) throw new AppError("NOT_FOUND", "연결된 폴더를 찾을 수 없습니다. 공유 폴더가 연결되어 있는지 확인하세요.");
      const dir = join(folder, LINK_DIR);
      await mkdir(dir, { recursive: true });
      const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
      const files: [string, string, ((old: string) => boolean)?][] = [];
      const projectJson = json(this.projectFile(projectId));
      files.push([LINK_FILES.project, projectJson, (old) => withoutTime(old) === withoutTime(projectJson)]);
      const archiveJson = json(this.archiveFile(projectId));
      files.push([LINK_FILES.archive, archiveJson, (old) => withoutTime(old) === withoutTime(archiveJson)]);
      const evidence = this.deps.evidence;
      if (this.deps.db.db.prepare("SELECT 1 FROM evidence_rows WHERE project_id=? LIMIT 1").get(projectId)) {
        files.push([LINK_FILES.evidenceCsv, evidence.render(projectId, { kind: "archive" }, "csv")]);
        files.push([LINK_FILES.evidenceMd, evidence.render(projectId, { kind: "archive" }, "md")]);
      } else
        for (const name of [LINK_FILES.evidenceCsv, LINK_FILES.evidenceMd]) await rm(join(dir, name), { force: true });
      for (const [name, text, same] of files) if (await writeIfChanged(join(dir, name), text, same)) written.push(name);
      this.synced[projectId] = { at: now() };
    } catch (error) {
      this.synced[projectId] = { at: now(), error: error instanceof Error ? error.message : String(error) };
      throw error;
    }
    return { written };
  }

  /** Every few seconds, after the library changed, linked folders are brought up to date. */
  start(interval = 5000) {
    this.timer ??= setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  async tick() {
    const revision = this.deps.db.pref<number>("revision") ?? 0;
    if (this.syncing || revision === this.lastRevision || !this.root()) return;
    this.syncing = true;
    this.lastRevision = revision;
    try {
      for (const projectId of this.links().keys()) await this.sync(projectId).catch(() => {});
    } finally {
      this.syncing = false;
    }
  }
}
