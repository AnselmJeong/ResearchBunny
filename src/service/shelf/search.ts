import type { Library } from "../db/database";
import type { Shelf } from "./indexer";
import { embedInput } from "./indexer";
import { normalizeDoi, normalizeOpenAlex, normalizePmid, titleSimilarity, tokens } from "../../shared/domain";
import type { ShelfMembership, Work } from "../../shared/types";
import { authorMatches, titleKey, type ShelfFileInfo, type ShelfHit, type ShelfRelated, type ShelfRelatedItem, type ShelfSearchResult } from "../../shared/shelf";

// With OR, a function word would match almost every paper and fill the lexical list.
const STOPWORDS = new Set(
  "about after an and are as at be between by can do does for from has have how in into is it its of on or than that the their these this those to via vs was were what when which who why with".split(" "),
);
/** Quote each term so user text can never become FTS5 syntax; OR lets BM25 rank partial matches. */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set((text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []))].filter((t) => !STOPWORDS.has(t)).slice(0, 32);
  return terms.length ? terms.map((t) => `"${t}"`).join(" OR ") : null;
}
/** Reciprocal rank fusion, k = 60 as in mergeScholarlyResults. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, index) => scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1)));
  return scores;
}
/**
 * Semantic hits must reach this cosine and stay within SEMANTIC_WINDOW of the best
 * hit. With embeddinggemma-2 and the search prompts, related query/abstract pairs
 * scored 0.69–0.85 and unrelated ones 0.47–0.66 (small hand check, 2026-10-11);
 * refine with the folder-agreement evaluation. Lexical hits are never filtered.
 */
export const SEMANTIC_FLOOR = 0.65;
export const SEMANTIC_WINDOW = 0.1;

interface IndexEntry {
  fileId: string;
  workId: string;
  folderId: string;
  folder: string;
  path: string;
  status: string;
  stage: string;
  title: string;
  year: number | null;
  firstAuthor: string;
  dois: string[];
  workDoi: string | null;
}
/** Title words regardless of order, case, punctuation, markup and stop words. */
const wordKey = (title: string) => [...new Set(tokens(title))].sort().join(" ");
const add = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

export class ShelfQueries {
  private index: { revision: number; byTitle: Map<string, IndexEntry[]>; byWords: Map<string, IndexEntry[]>; byDoi: Map<string, IndexEntry[]>; byWork: Map<string, IndexEntry[]>; entries: IndexEntry[] } | null = null;
  constructor(private db: Library, private shelf: Shelf) {}

  /** Shelf work ids (non-missing, non-auxiliary) for filtering searches and recommendations. */
  private shelfWorks(excludeAuxiliary = true): Set<string> {
    return new Set(
      (this.db.db.prepare(`SELECT DISTINCT work_id FROM shelf_files WHERE work_id IS NOT NULL AND status!='missing'${excludeAuxiliary ? " AND status!='auxiliary'" : ""}`).all() as { work_id: string }[])
        .map((r) => r.work_id),
    );
  }
  private folders(ids: string[]): Map<string, { folderId: string; folder: string }> {
    const memberships = this.db.shelfMemberships(ids);
    return new Map([...memberships].map(([id, m]) => [id, { folderId: m.folderId, folder: m.folder }]));
  }

  async search(query: string, opts: { limit: number; folderIds?: string[]; signal?: AbortSignal }): Promise<ShelfSearchResult> {
    const signal = opts.signal || AbortSignal.timeout(15000);
    const allowed = opts.folderIds?.length ? new Set(opts.folderIds.flatMap((id) => this.db.shelfScope(id))) : this.shelfWorks(false);
    const identifier = normalizeOpenAlex(query) ? ["openalex", normalizeOpenAlex(query)!] : normalizeDoi(query) ? ["doi", normalizeDoi(query)!] : normalizePmid(query) ? ["pmid", normalizePmid(query)!] : null;
    if (identifier) {
      const id = this.db.findIdentifier(identifier[0], identifier[1]);
      const hits = id && allowed.has(id) ? [id] : [];
      return { hits: this.hits(hits, new Map(hits.map((h) => [h, 1])), [], []), semantic: false, identifier: true };
    }
    const lexical: string[] = [];
    const fts = ftsQuery(query);
    if (fts)
      for (const row of this.db.db.prepare("SELECT work_id FROM shelf_fts WHERE shelf_fts MATCH ? ORDER BY bm25(shelf_fts,0.0,3.0,2.0,1.0,0.5) LIMIT 200").all(fts) as { work_id: string }[])
        if (allowed.has(row.work_id) && lexical.length < 100) lexical.push(row.work_id);
    let semantic: string[] = [];
    let used = false;
    const vector = await this.shelf.embedText("query", "", query, signal).catch(() => null);
    const key = this.shelf.currentModelKey();
    if (vector && key) {
      this.shelf.vectors.ensure(key);
      const eligible = this.shelfWorks(true);
      // Every paper has some nearest neighbour; keep only semantically close ones.
      const hits = this.shelf.vectors.search(vector, 100, (id) => allowed.has(id) && eligible.has(id));
      const floor = Math.max(SEMANTIC_FLOOR, (hits[0]?.score ?? 0) - SEMANTIC_WINDOW);
      semantic = hits.filter((hit) => hit.score >= floor).map((hit) => hit.id);
      used = true;
    }
    const scores = rrf([lexical, semantic]);
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, opts.limit)
      .map(([id]) => id);
    return { hits: this.hits(ranked, scores, lexical, semantic), semantic: used };
  }
  private hits(ids: string[], scores: Map<string, number>, lexical: string[], semantic: string[]): ShelfHit[] {
    const folders = this.folders(ids);
    return ids.map((workId) => ({
      workId,
      score: Math.round((scores.get(workId) || 0) * 10000) / 10000,
      lexicalRank: lexical.includes(workId) ? lexical.indexOf(workId) + 1 : null,
      semanticRank: semantic.includes(workId) ? semantic.indexOf(workId) + 1 : null,
      folderId: folders.get(workId)?.folderId || "",
      folder: folders.get(workId)?.folder || "",
    }));
  }

  /** Vector for a work: stored shelf embedding, or an on-the-fly (cached) one for papers outside the shelf. */
  async workVector(work: Work, signal: AbortSignal) {
    const key = this.shelf.currentModelKey();
    if (key) {
      this.shelf.vectors.ensure(key);
      const stored = this.shelf.vectors.vector(work.id);
      if (stored) {
        const basis = (this.db.db.prepare("SELECT basis FROM work_embeddings WHERE work_id=? AND model=?").get(work.id, key) as { basis: string } | undefined)?.basis;
        return { vector: stored, basis: (basis || "abstract") as ShelfRelated["basis"] };
      }
    }
    const info = this.firstInfo(work.id);
    const source = embedInput(work, info);
    const vector = await this.shelf.embedText("document", source.title, source.text, signal);
    return vector ? { vector, basis: source.basis } : null;
  }
  private firstInfo(workId: string): ShelfFileInfo | null {
    const row = this.db.db.prepare("SELECT info FROM shelf_files WHERE work_id=? AND status!='missing' ORDER BY rel_path LIMIT 1").get(workId) as { info: string } | undefined;
    return row ? JSON.parse(row.info) : null;
  }

  async related(workId: string, opts: { limit: number; otherFoldersOnly: boolean; signal?: AbortSignal }): Promise<ShelfRelated> {
    const signal = opts.signal || AbortSignal.timeout(15000);
    const work = this.db.get(workId);
    const eligible = this.shelfWorks(true);
    const own = new Set(
      (this.db.db.prepare("SELECT DISTINCT folder_id FROM shelf_files WHERE work_id=? AND status!='missing'").all(workId) as { folder_id: string }[]).map((r) => r.folder_id),
    );
    let similar: ShelfRelatedItem[] = [];
    let semantic = false;
    let basis: ShelfRelated["basis"] = null;
    const notices: string[] = [];
    const source = await this.workVector(work, signal).catch(() => null);
    if (source) {
      semantic = true;
      basis = source.basis;
      const key = this.shelf.currentModelKey()!;
      this.shelf.vectors.ensure(key);
      let accept = (id: string) => id !== workId && eligible.has(id);
      if (opts.otherFoldersOnly && own.size) {
        const sameFolder = new Set(
          (this.db.db.prepare("SELECT DISTINCT work_id FROM shelf_files WHERE folder_id IN (SELECT value FROM json_each(?)) AND work_id IS NOT NULL").all(JSON.stringify([...own])) as { work_id: string }[]).map((r) => r.work_id),
        );
        const base = accept;
        accept = (id) => base(id) && !sameFolder.has(id);
      }
      const hits = this.shelf.vectors.search(source.vector, opts.limit, accept);
      const bases = new Map(
        (this.db.db.prepare("SELECT work_id,basis FROM work_embeddings WHERE model=? AND work_id IN (SELECT value FROM json_each(?))").all(key, JSON.stringify(hits.map((h) => h.id))) as { work_id: string; basis: string }[])
          .map((r) => [r.work_id, r.basis]),
      );
      const weak = (b?: string | null) => b === "page1" || b === "title";
      // Each row flags only its own basis; a weak basis for this paper is one notice for the whole list.
      similar = this.items(hits.map((h) => h.id), new Map(hits.map((h) => [h.id, h.score])), (id) => weak(bases.get(id)));
      if (weak(basis)) notices.push(`이 논문은 초록이 없어 ${basis === "page1" ? "PDF 첫 쪽" : "제목"}으로 비교했습니다 · 정확도 낮음`);
    } else notices.push("Ollama 임베딩을 쓸 수 없어 인용 연결만 보여 줍니다.");
    // Citation links use the local citations table only; no API call.
    const cites = work.openalex || work.references?.length
      ? (this.db.db.prepare("SELECT DISTINCT i.work_id FROM citations c JOIN identifiers i ON i.provider='openalex' AND i.value=c.cited_external WHERE c.citing_id=?").all(workId) as { work_id: string }[])
          .map((r) => r.work_id).filter((id) => id !== workId && eligible.has(id))
      : [];
    const citedBy = work.openalex
      ? (this.db.db.prepare("SELECT DISTINCT citing_id FROM citations WHERE cited_external=?").all(work.openalex) as { citing_id: string }[])
          .map((r) => r.citing_id).filter((id) => id !== workId && eligible.has(id))
      : [];
    return {
      similar,
      cites: this.items(cites.slice(0, 50), new Map(), () => false),
      citedBy: this.items(citedBy.slice(0, 50), new Map(), () => false),
      semantic,
      basis,
      notice: notices.join(" "),
    };
  }
  private items(ids: string[], scores: Map<string, number>, low: (id: string) => boolean): ShelfRelatedItem[] {
    if (!ids.length) return [];
    const folders = this.folders(ids);
    const works = new Map(
      (this.db.db.prepare("SELECT id,json_extract(data,'$.title') AS title,json_extract(data,'$.authors') AS authors,json_extract(data,'$.year') AS year FROM works WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { id: string; title: string; authors: string; year: number | null }[])
        .map((r) => [r.id, r]),
    );
    return ids.flatMap((id) => {
      const w = works.get(id);
      return w ? [{ workId: id, title: w.title, authors: JSON.parse(w.authors || "[]").slice(0, 4), year: w.year, folder: folders.get(id)?.folder || "", score: Math.round((scores.get(id) ?? 0) * 1000) / 1000, lowConfidence: low(id) }] : [];
    });
  }

  // ---- matching papers outside the shelf to shelf files ----
  private ensureIndex() {
    if (this.index && this.index.revision === this.shelf.revision) return this.index;
    const rows = this.db.db.prepare(
      `SELECT f.id,f.work_id,f.folder_id,fo.rel_path AS folder,f.rel_path,r.path AS root,f.status,f.stage,
        json_extract(f.info,'$.parsed.title') AS ptitle,json_extract(f.info,'$.parsed.year') AS pyear,json_extract(f.info,'$.parsed.authors[0]') AS pauthor,
        json_extract(f.info,'$.dois') AS dois,json_extract(f.info,'$.duplicateOf') AS dup,
        json_extract(w.data,'$.title') AS wtitle,json_extract(w.data,'$.year') AS wyear,json_extract(w.data,'$.doi') AS wdoi
       FROM shelf_files f JOIN shelf_folders fo ON fo.id=f.folder_id JOIN shelf_roots r ON r.id=f.root_id LEFT JOIN works w ON w.id=f.work_id
       WHERE f.status NOT IN ('missing','auxiliary') AND f.work_id IS NOT NULL`,
    ).all() as { id: string; work_id: string; folder_id: string; folder: string; rel_path: string; root: string; status: string; stage: string; ptitle: string | null; pyear: number | null; pauthor: string | null; dois: string | null; dup: string | null; wtitle: string | null; wyear: number | null; wdoi: string | null }[];
    const byTitle = new Map<string, IndexEntry[]>(), byWords = new Map<string, IndexEntry[]>(), byDoi = new Map<string, IndexEntry[]>(), byWork = new Map<string, IndexEntry[]>();
    const entries: IndexEntry[] = [];
    for (const r of rows) {
      if (r.dup) continue;
      const entry: IndexEntry = {
        fileId: r.id, workId: r.work_id, folderId: r.folder_id, folder: r.folder || "수신함", path: `${r.root}/${r.rel_path}`,
        status: r.status, stage: r.stage, title: r.ptitle || r.wtitle || "", year: r.pyear ?? r.wyear ?? null,
        firstAuthor: r.pauthor || "", dois: JSON.parse(r.dois || "[]"), workDoi: r.wdoi,
      };
      entries.push(entry);
      add(byWork, r.work_id, entry);
      for (const key of new Set([titleKey(r.ptitle || ""), titleKey(r.wtitle || "")]))
        if (key.length >= 12) add(byTitle, key, entry);
      for (const key of new Set([wordKey(r.ptitle || ""), wordKey(r.wtitle || "")]))
        if (key.replace(/ /g, "").length >= 12) add(byWords, key, entry);
      for (const doi of new Set([r.wdoi, ...entry.dois].filter(Boolean) as string[]))
        add(byDoi, doi, entry);
    }
    this.index = { revision: this.shelf.revision, byTitle, byWords, byDoi, byWork, entries };
    return this.index;
  }
  /**
   * Shelf files for a paper outside the shelf: the same DOI with title similarity ≥ 0.5,
   * or, without a conflicting DOI and within a year, the same title, or the same title
   * words (order, stop words, punctuation and markup aside) by the same first author.
   */
  matchShelf(work: Work): IndexEntry[] {
    const index = this.ensureIndex();
    const doi = normalizeDoi(work.doi);
    const found = new Map<string, IndexEntry>();
    for (const entry of doi ? index.byDoi.get(doi) || [] : []) {
      if (entry.workDoi === doi || titleSimilarity(entry.title, work.title) >= 0.5) found.set(entry.fileId, entry);
    }
    const compatible = (entry: IndexEntry) =>
      !(doi && entry.workDoi && entry.workDoi !== doi) && (!work.year || !entry.year || Math.abs(work.year - entry.year) <= 1);
    for (const entry of index.byTitle.get(titleKey(work.title)) || []) if (compatible(entry)) found.set(entry.fileId, entry);
    for (const entry of index.byWords.get(wordKey(work.title)) || [])
      if (compatible(entry) && authorMatches(entry.firstAuthor, work.authors[0])) found.set(entry.fileId, entry);
    // Several files of one work (copies) are one candidate.
    const byWork = new Map<string, IndexEntry>();
    for (const entry of found.values()) if (!byWork.has(entry.workId)) byWork.set(entry.workId, entry);
    return [...byWork.values()].filter((entry) => entry.workId !== work.id);
  }
  /** Shelf files that hold a paper, checked before any download: its own shelf file, else matching files. */
  heldBy(work: Work): (IndexEntry & { own: boolean })[] {
    const own = this.ensureIndex().byWork.get(work.id);
    return own ? [{ ...own[0], own: true }] : this.matchShelf(work).map((entry) => ({ ...entry, own: false }));
  }
  /** "Same title in the shelf" hints for search results not merged into a shelf work. */
  hints(works: Work[]): Map<string, ShelfMembership> {
    const map = new Map<string, ShelfMembership>();
    if (!works.length || !this.shelf.root()) return map;
    for (const work of works) {
      const match = this.matchShelf(work)[0];
      if (match)
        map.set(work.id, { fileId: match.fileId, folderId: match.folderId, folder: match.folder, path: match.path, status: match.status, stage: match.stage, copies: 1, match: "title" });
    }
    return map;
  }
}
