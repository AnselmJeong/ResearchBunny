import type Database from "../db/sqlite";
import { ftsQuery, rrf } from "../shelf/search";
import type { PassageHit, PassageSearchResult } from "../../shared/passages";
import { CHUNKER_VERSION } from "./chunker";
import type { PassageStore } from "./store";

/** Semantic hits below this cosine are noise; passages score lower than whole abstracts against short queries. */
export const PASSAGE_FLOOR = 0.5;
export const PASSAGE_WINDOW = 0.15;

/** Words as the FTS tokenizer sees them: case and diacritics folded. */
const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase();
const words = (text: string) => new Set(fold(text).match(/[\p{L}\p{N}]+/gu) || []);

interface FileEntry {
  workId: string;
  fileId: string;
  attachmentId: string | null;
  folderId: string;
  folder: string;
}

/** Hybrid passage search: BM25 over passage text and meaning search over passage vectors, fused by reciprocal rank. */
export class PassageSearch {
  private files: { key: string; byHash: Map<string, FileEntry> } | null = null;
  private counted: { stamp: number; model: string | null; counts: ReturnType<PassageStore["counts"]> } | null = null;
  constructor(
    private lib: Database,
    private store: PassageStore,
    private embedQuery: (query: string, signal: AbortSignal) => Promise<{ vector: Float32Array; model: string } | null>,
  ) {}

  /** Shelf files by content hash, rebuilt when the shelf changes. */
  private byHash(revision: string) {
    if (this.files?.key === revision) return this.files.byHash;
    const rows = this.lib.prepare(
      `SELECT f.hash,f.work_id,f.id,f.attachment_id,f.folder_id,fo.rel_path AS folder FROM shelf_files f JOIN shelf_folders fo ON fo.id=f.folder_id
       WHERE f.hash IS NOT NULL AND f.work_id IS NOT NULL AND f.status NOT IN ('missing','auxiliary','hidden','failed') AND json_extract(f.info,'$.duplicateOf') IS NULL
       ORDER BY f.rel_path`,
    ).all() as { hash: string; work_id: string; id: string; attachment_id: string | null; folder_id: string; folder: string }[];
    const byHash = new Map<string, FileEntry>();
    for (const r of rows)
      if (!byHash.has(r.hash)) byHash.set(r.hash, { workId: r.work_id, fileId: r.id, attachmentId: r.attachment_id, folderId: r.folder_id, folder: r.folder || "수신함" });
    this.files = { key: revision, byHash };
    return byHash;
  }

  /** Counting every vector takes about 0.1 s at 400K passages; the counts only change with the store's stamp. */
  private counts(model: string | null) {
    const stamp = this.store.meta<number>("stamp") || 0;
    if (this.counted?.stamp !== stamp || this.counted.model !== model) this.counted = { stamp, model, counts: this.store.counts(model) };
    return this.counted.counts;
  }

  /**
   * Passages for a question or keywords. `works` limits the search to those
   * papers (a folder, a collection); `perWork` keeps one long paper from filling
   * the list.
   */
  async search(query: string, opts: { limit: number; revision: string; works?: Set<string>; perWork?: number; signal?: AbortSignal }): Promise<PassageSearchResult> {
    const signal = opts.signal || AbortSignal.timeout(20000);
    const files = this.byHash(opts.revision);
    const allowedHash = (hash: string) => {
      const file = files.get(hash);
      return !!file && (!opts.works || opts.works.has(file.workId));
    };
    const fts = ftsQuery(query);
    const terms = fts ? [...fts.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
    let lexical: number[] = [];
    if (fts) {
      // One word of a question matches thousands of passages; keep those holding
      // at least half the words, most words first, then by BM25.
      const found = this.store.lexical(fts, 400).filter((r) => allowedHash(r.hash));
      const texts = this.store.passages(found.map((r) => r.id));
      const wanted = terms.map(fold);
      const need = wanted.length <= 2 ? 1 : Math.ceil(wanted.length / 2);
      lexical = found
        .map((r, rank) => {
          const row = texts.get(r.id);
          const has = row ? words(`${row.section} ${row.text}`) : new Set<string>();
          return { id: r.id, rank, matched: wanted.filter((w) => has.has(w)).length };
        })
        .filter((r) => r.matched >= need)
        .sort((a, b) => b.matched - a.matched || a.rank - b.rank)
        .slice(0, 200)
        .map((r) => r.id);
    }
    let semantic: number[] = [];
    let used = false;
    const embedded = await this.embedQuery(query, signal).catch(() => null);
    if (embedded) {
      used = true;
      // A scope is filtered inside the scan, so a small folder still gets its closest passages.
      let accept = (_id: number) => true;
      if (opts.works) {
        const hashes = [...files].filter(([, f]) => opts.works!.has(f.workId)).map(([hash]) => hash);
        const ids = new Set(this.store.idsOf(hashes));
        accept = (id) => ids.has(id);
      }
      const hits = this.store.semantic(embedded.model, embedded.vector, 200, accept);
      const floor = Math.max(PASSAGE_FLOOR, (hits[0]?.score ?? 0) - PASSAGE_WINDOW);
      semantic = hits.filter((h) => h.score >= floor).map((h) => h.id);
    }
    const scores = rrf([lexical.map(String), semantic.map(String)]);
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => Number(id));
    const rows = this.store.passages(ranked.slice(0, Math.max(opts.limit * 6, 120)));
    const perWork = new Map<string, number>();
    const picked: { id: number; file: FileEntry }[] = [];
    for (const id of ranked) {
      if (picked.length >= opts.limit) break;
      const row = rows.get(id);
      const file = row && files.get(row.hash);
      if (!row || !file || (opts.works && !opts.works.has(file.workId))) continue;
      const count = perWork.get(file.workId) || 0;
      if (count >= (opts.perWork ?? 3)) continue;
      perWork.set(file.workId, count + 1);
      picked.push({ id, file });
    }
    const works = new Map(
      (this.lib.prepare("SELECT id,json_extract(data,'$.title') AS title,json_extract(data,'$.authors') AS authors,json_extract(data,'$.year') AS year FROM works WHERE id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify([...new Set(picked.map((p) => p.file.workId))])) as { id: string; title: string; authors: string | null; year: number | null }[])
        .map((w) => [w.id, w]),
    );
    const hits: PassageHit[] = picked.flatMap(({ id, file }) => {
      const row = rows.get(id)!;
      const work = works.get(file.workId);
      if (!work) return [];
      return [{
        passageId: id,
        workId: file.workId,
        fileId: file.fileId,
        attachmentId: file.attachmentId,
        title: work.title,
        authors: (JSON.parse(work.authors || "[]") as string[]).slice(0, 4),
        year: work.year,
        folder: file.folder,
        page: row.page_start,
        pageEnd: row.page_end,
        // Passages split before the worker dropped control characters may still hold NULs.
        section: row.section.replace(/\p{Cc}/gu, ""),
        text: row.text.replace(/(?!\n)\p{Cc}/gu, ""),
        score: Math.round((scores.get(String(id)) || 0) * 10000) / 10000,
        lexicalRank: lexical.includes(id) ? lexical.indexOf(id) + 1 : null,
        semanticRank: semantic.includes(id) ? semantic.indexOf(id) + 1 : null,
      }];
    });
    const docs = this.store.docs();
    const counts = this.counts(embedded?.model ?? this.store.meta<string>("model"));
    return {
      hits,
      terms,
      semantic: used,
      coverage: { docs: [...files.keys()].filter((h) => docs.get(h)?.chunker === CHUNKER_VERSION).length, total: files.size, embedded: counts.embedded, passages: counts.passages },
    };
  }
}
