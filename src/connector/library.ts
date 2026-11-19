import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "../service/db/sqlite";
import { PASSAGE_FILE, PassageStore } from "../service/passages/store";
import { PassageSearch } from "../service/passages/search";
import { vectorModel } from "../service/passages/indexer";
import { OllamaLocal } from "../service/providers/ollama-local";
import { ScreeningStore } from "../service/screening/store";
import { EvidenceStore } from "../service/evidence";
import { DEFAULT_OLLAMA_URL, EMBED_PROMPTS, type ShelfConfig } from "../shared/shelf";
import { LINK_DIR, LINK_FILES, type LinkedProjectFile } from "../shared/scholarpen";
import { normalizeDoi, normalizePmid, pmidOf, titleSimilarity } from "../shared/domain";
import type { Work } from "../shared/types";
import type { PassageHit } from "../shared/passages";
import { CHARACTER_TYPES, CONTRIBUTIONS, type CharacterType, type Contribution } from "../shared/screening";

export class ConnectorError extends Error {}

/** Which papers a tool looks at. Everything stays inside one project unless `kind` is "shelf". */
export interface Scope {
  project?: string;
  kind?: "archive" | "collection" | "topic" | "character" | "ids" | "shelf";
  /** A collection's or topic's name or id. */
  name?: string;
  /** A paper type (R, M, O) or contribution (method, primary, …). */
  character?: string;
  ids?: string[];
}

/**
 * The library and the passage index, opened read-only. Nothing here writes:
 * the ResearchBunny app may be running or not, and its files are only read.
 */
export class ConnectorLibrary {
  readonly lib: Database;
  readonly passages: PassageStore | null;
  readonly search: PassageSearch | null;
  readonly screening: ScreeningStore;
  readonly evidence: EvidenceStore;
  private config: ShelfConfig | null;
  private ollama: OllamaLocal;
  /** The project a scope without one falls back to: from --project, or the linked folder the connector runs in. */
  defaultProject: string | null = null;

  constructor(readonly root: string, options: { project?: string; cwd?: string; fetcher?: typeof fetch } = {}) {
    const path = join(root, "library.sqlite");
    if (!existsSync(path)) throw new ConnectorError(`No ResearchBunny library at ${path}`);
    this.lib = new Database(path, { readonly: true });
    this.lib.pragma("busy_timeout = 5000");
    this.lib.pragma("query_only = ON");
    const passagePath = join(root, PASSAGE_FILE);
    this.passages = existsSync(passagePath) ? new PassageStore(passagePath, { readonly: true }) : null;
    this.config = this.pref<ShelfConfig>("shelf");
    this.ollama = new OllamaLocal(() => this.config?.ollamaUrl || DEFAULT_OLLAMA_URL, options.fetcher);
    this.search = this.passages ? new PassageSearch(this.lib, this.passages, (query, signal) => this.embedQuery(query, signal)) : null;
    this.screening = new ScreeningStore(this.lib, (id) => this.projectRow(id)?.question ?? "");
    this.evidence = new EvidenceStore(this.lib, (id) => this.screening.profile(id).purpose);
    const fromFolder = options.cwd ? this.linkedProjectIn(options.cwd) : null;
    this.defaultProject = options.project ? this.project(options.project).id : fromFolder;
  }
  close() {
    this.passages?.close();
    this.lib.close();
  }

  pref<T>(key: string): T | null {
    const row = this.lib.prepare("SELECT data FROM preferences WHERE key=?").get(key) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }
  revision() {
    return `${this.pref<number>("revision") ?? 0}:${this.passages?.meta<number>("stamp") ?? 0}`;
  }

  /** The query's vector from the local Ollama, or null (words-only search) when it is off. */
  private async embedQuery(query: string, signal: AbortSignal): Promise<{ vector: Float32Array; model: string } | null> {
    if (!this.config) return null;
    const status = await this.ollama.status(this.config.model, AbortSignal.any([signal, AbortSignal.timeout(2000)]));
    if (!status.running || !status.modelInstalled || !status.modelKey) return null;
    const [vector] = await this.ollama.embed(this.config.model, [EMBED_PROMPTS.query(query)], signal);
    return { vector, model: vectorModel(status.modelKey) };
  }

  private projectRow(idOrName: string) {
    return this.lib.prepare("SELECT id,name,question FROM projects WHERE id=? OR name=? ORDER BY id=? DESC LIMIT 1").get(idOrName, idOrName, idOrName) as { id: string; name: string; question: string } | undefined;
  }
  project(idOrName?: string) {
    const key = idOrName || this.defaultProject;
    if (!key) throw new ConnectorError("No project given. Pass scope.project (an id or name from list_projects), or start the connector with --project or inside a linked ScholarPen folder.");
    const row = this.projectRow(key);
    if (!row) throw new ConnectorError(`No project ${key}. Call list_projects for the ids and names.`);
    return row;
  }
  /** The ResearchBunny project a ScholarPen folder is linked to, from its `.researchbunny/project.json`. */
  linkedProjectIn(dir: string): string | null {
    try {
      const file = JSON.parse(readFileSync(join(dir, LINK_DIR, LINK_FILES.project), "utf8")) as LinkedProjectFile;
      return this.projectRow(file.projectId)?.id ?? null;
    } catch {
      return null;
    }
  }
  projects() {
    const links = new Map((this.tableExists("project_links") ? (this.lib.prepare("SELECT project_id,folder FROM project_links").all() as { project_id: string; folder: string }[]) : []).map((r) => [r.project_id, r.folder]));
    return (this.lib.prepare(
      `SELECT p.id,p.name,p.question,(SELECT count(*) FROM project_works pw WHERE pw.project_id=p.id AND json_extract(pw.state,'$.screening')='included') AS archive FROM projects p ORDER BY p.created_at`,
    ).all() as { id: string; name: string; question: string; archive: number }[]).map((p) => ({ ...p, linkedFolder: links.get(p.id) ?? null, current: p.id === this.defaultProject }));
  }
  private tableExists(name: string) {
    return !!this.lib.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }

  /** The work ids a scope names. */
  scopeIds(scope: Scope = {}): { projectId: string | null; ids: string[] } {
    const kind = scope.kind ?? "archive";
    if (kind === "shelf") return { projectId: scope.project ? this.project(scope.project).id : this.defaultProject, ids: (this.lib.prepare("SELECT DISTINCT work_id AS id FROM shelf_files WHERE work_id IS NOT NULL AND status!='missing'").all() as { id: string }[]).map((r) => r.id) };
    const projectId = this.project(scope.project).id;
    const archive = (this.lib.prepare("SELECT work_id AS id FROM project_works WHERE project_id=? AND json_extract(state,'$.screening')='included'").all(projectId) as { id: string }[]).map((r) => r.id);
    if (kind === "archive") return { projectId, ids: archive };
    if (kind === "ids") {
      if (!scope.ids?.length) throw new ConnectorError("scope.ids is empty.");
      return { projectId, ids: [...new Set(scope.ids)] };
    }
    if (kind === "collection" || kind === "topic") {
      if (!scope.name) throw new ConnectorError(`scope.name must name the ${kind}. Call list_scopes for the names.`);
      const table = kind === "collection" ? "collections" : "archive_topics";
      const row = this.lib.prepare(`SELECT id FROM ${table} WHERE project_id=? AND (id=? OR name=?)`).get(projectId, scope.name, scope.name) as { id: string } | undefined;
      if (!row) throw new ConnectorError(`No ${kind} ${scope.name} in this project. Call list_scopes for the names.`);
      const members = kind === "collection"
        ? (this.lib.prepare("SELECT cw.work_id AS id FROM collection_works cw JOIN project_works pw ON pw.work_id=cw.work_id AND pw.project_id=? WHERE cw.collection_id=? AND json_extract(pw.state,'$.screening')!='trash'").all(projectId, row.id) as { id: string }[])
        : (this.lib.prepare("SELECT work_id AS id FROM archive_topic_works WHERE project_id=? AND topic_id=?").all(projectId, row.id) as { id: string }[]);
      return { projectId, ids: members.map((r) => r.id) };
    }
    const wanted = scope.character;
    if (!wanted || !(wanted in CHARACTER_TYPES || wanted in CONTRIBUTIONS))
      throw new ConnectorError(`scope.character must be one of ${[...Object.keys(CHARACTER_TYPES), ...Object.keys(CONTRIBUTIONS)].join(", ")}.`);
    const characters = this.screening.characters(archive);
    return {
      projectId,
      ids: archive.filter((id) => {
        const c = characters.get(id);
        return wanted in CHARACTER_TYPES ? c?.type === (wanted as CharacterType) : !!c?.contributions.includes(wanted as Contribution);
      }),
    };
  }

  works(ids: string[]): Map<string, Work> {
    return new Map((this.lib.prepare("SELECT id,data FROM works WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { id: string; data: string }[]).map((r) => {
      const work = JSON.parse(r.data) as Work;
      return [r.id, { ...work, pmid: pmidOf(work) }];
    }));
  }
  /** Works with a PDF (attached or on the shelf) and works whose PDF passages are indexed. */
  fulltext(ids: string[]): { pdf: Set<string>; indexed: Set<string> } {
    const list = JSON.stringify(ids);
    const pdf = new Set((this.lib.prepare("SELECT DISTINCT work_id AS id FROM attachments WHERE work_id IN (SELECT value FROM json_each(?)) UNION SELECT DISTINCT work_id FROM shelf_files WHERE status!='missing' AND work_id IN (SELECT value FROM json_each(?))").all(list, list) as { id: string }[]).map((r) => r.id));
    const indexed = new Set<string>();
    if (this.passages) {
      const docs = this.passages.docs();
      for (const r of this.hashes(ids)) if (docs.get(r.hash)?.status === "ok") indexed.add(r.workId);
    }
    return { pdf, indexed };
  }
  private hashes(ids: string[]) {
    return (this.lib.prepare("SELECT work_id AS workId,hash,id AS fileId,attachment_id AS attachmentId FROM shelf_files WHERE hash IS NOT NULL AND status NOT IN ('missing','failed') AND work_id IN (SELECT value FROM json_each(?)) ORDER BY json_extract(info,'$.duplicateOf') IS NOT NULL").all(JSON.stringify(ids)) as { workId: string; hash: string; fileId: string; attachmentId: string | null }[]);
  }
  /** One paper's passages in reading order, within a page range. */
  workPassages(workId: string, from = 1, to = 100000, limit = 60): { page: number; pageEnd: number; section: string; text: string; passageId: number }[] {
    if (!this.passages) return [];
    const file = this.hashes([workId])[0];
    if (!file) return [];
    return (this.passages.db.prepare("SELECT id,page_start,page_end,section,text FROM passages WHERE hash=? AND page_end>=? AND page_start<=? ORDER BY seq LIMIT ?").all(file.hash, from, to, limit) as { id: number; page_start: number; page_end: number; section: string; text: string }[])
      .map((p) => ({ passageId: p.id, page: p.page_start, pageEnd: p.page_end, section: p.section, text: p.text }));
  }
  async searchPassages(query: string, ids: string[], limit: number, perWork: number): Promise<{ hits: PassageHit[]; semantic: boolean }> {
    if (!this.search) return { hits: [], semantic: false };
    const result = await this.search.search(query, { limit, perWork, works: new Set(ids), revision: this.revision(), signal: AbortSignal.timeout(20000) });
    return { hits: result.hits, semantic: result.semantic };
  }

  /** A DOI, PMID or title (with a year) to a library work: DOI first, then PMID, then the closest title. */
  resolve(item: { doi?: string; pmid?: string; title?: string; year?: number }): { workId: string; match: "doi" | "pmid" | "title" } | null {
    const by = (provider: string, value: string | null) =>
      value ? ((this.lib.prepare("SELECT work_id FROM identifiers WHERE provider=? AND value=?").get(provider, value) as { work_id: string } | undefined)?.work_id ?? null) : null;
    const doi = by("doi", normalizeDoi(item.doi ?? null));
    if (doi) return { workId: doi, match: "doi" };
    const pmid = by("pmid", normalizePmid(item.pmid ?? null));
    if (pmid) return { workId: pmid, match: "pmid" };
    if (!item.title?.trim() || item.title.trim().length < 12) return null;
    const words = item.title.toLowerCase().match(/[a-z0-9]{4,}/g)?.slice(0, 3) ?? [];
    const rows = this.lib.prepare(
      `SELECT id,json_extract(data,'$.title') AS title,json_extract(data,'$.year') AS year FROM works WHERE ${words.map(() => "lower(json_extract(data,'$.title')) LIKE ?").join(" AND ") || "1"} LIMIT 200`,
    ).all(...words.map((w) => `%${w}%`)) as { id: string; title: string; year: number | null }[];
    const best = rows
      .filter((r) => !item.year || !r.year || Math.abs(r.year - item.year) <= 1)
      .map((r) => ({ id: r.id, score: titleSimilarity(r.title, item.title!) }))
      .sort((a, b) => b.score - a.score)[0];
    return best && best.score >= 0.8 ? { workId: best.id, match: "title" } : null;
  }
  screeningState(projectId: string, workId: string): string | null {
    const row = this.lib.prepare("SELECT json_extract(state,'$.screening') AS s FROM project_works WHERE project_id=? AND work_id=?").get(projectId, workId) as { s: string } | undefined;
    return row?.s ?? null;
  }
  collectionsAndTopics(projectId: string) {
    const collections = this.lib.prepare(
      `SELECT c.id,c.name,(SELECT count(*) FROM collection_works cw JOIN project_works pw ON pw.work_id=cw.work_id AND pw.project_id=c.project_id WHERE cw.collection_id=c.id AND json_extract(pw.state,'$.screening')!='trash') AS count FROM collections c WHERE c.project_id=? ORDER BY c.name`,
    ).all(projectId) as { id: string; name: string; count: number }[];
    const topics = this.lib.prepare(
      `SELECT t.id,t.name,t.description,(SELECT count(*) FROM archive_topic_works tw WHERE tw.topic_id=t.id) AS count FROM archive_topics t WHERE t.project_id=? ORDER BY t.position`,
    ).all(projectId) as { id: string; name: string; description: string; count: number }[];
    return { collections, topics };
  }
}
