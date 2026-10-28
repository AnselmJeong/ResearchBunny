import { renameSync } from "node:fs";
import Database from "../db/sqlite";
import { now } from "../../shared/types";
import type { Split } from "./chunker";

export const PASSAGE_FILE = "passages.sqlite";
const SCHEMA = 1;
/** 768 sign bits per vector, as 24 unsigned 32-bit words. */
const WORDS = 24;

export interface DocRow {
  hash: string;
  chunker: string;
  status: "ok" | "empty" | "failed";
}
export interface PendingPassage {
  id: number;
  title: string;
  section: string;
  text: string;
}
export interface PassageRow {
  id: number;
  hash: string;
  seq: number;
  page_start: number;
  page_end: number;
  section: string;
  text: string;
}

const popcount = (x: number) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
/** int8 with one scale per vector: a quarter of float32 and a cosine error far below ranking noise. */
export function quantize(vector: Float32Array): { scale: number; data: Uint8Array } {
  let max = 0;
  for (const v of vector) max = Math.max(max, Math.abs(v));
  const scale = max / 127 || 1;
  const data = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) data[i] = Math.round(vector[i] / scale);
  return { scale, data: new Uint8Array(data.buffer) };
}
const int8 = (blob: Uint8Array) => new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);

/**
 * The index is derived data, so a file that cannot be opened (damaged, or from
 * a newer app) is set aside and indexing starts over instead of stopping the app.
 */
export function openPassageStore(path: string): PassageStore {
  try {
    return new PassageStore(path);
  } catch {
    const aside = `${path}.unusable-${Date.now()}`;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        renameSync(path + suffix, aside + suffix);
      } catch {
        // Not every companion file exists.
      }
    }
    return new PassageStore(path);
  }
}

/**
 * Passages of shelf PDFs, keyed by the PDF's content hash so moves and renames
 * keep them. Text sits in FTS5; vectors are int8 in SQLite. For meaning search
 * the store keeps only sign bits of every vector in memory (about 100 MB per
 * million passages): a Hamming scan picks candidates, then their int8 vectors
 * are read back and scored exactly.
 */
export class PassageStore {
  db: Database;
  private codes: { model: string; stamp: number; loadedAt: number; ids: Int32Array; bits: Uint32Array; mean: Float32Array; size: number } | null = null;

  constructor(path: string) {
    this.db = new Database(path);
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA) {
      this.db.close();
      throw new Error("passages.sqlite was written by a newer app");
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 10000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs(hash TEXT PRIMARY KEY,chunker TEXT NOT NULL,status TEXT NOT NULL,pages INTEGER,chars INTEGER NOT NULL DEFAULT 0,chunks INTEGER NOT NULL DEFAULT 0,refs_excluded INTEGER NOT NULL DEFAULT 0,title TEXT NOT NULL DEFAULT '',message TEXT,extracted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS passages(id INTEGER PRIMARY KEY AUTOINCREMENT,hash TEXT NOT NULL REFERENCES docs(hash) ON DELETE CASCADE,seq INTEGER NOT NULL,page_start INTEGER NOT NULL,page_end INTEGER NOT NULL,section TEXT NOT NULL,text TEXT NOT NULL,UNIQUE(hash,seq));
      CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(section,text,content='passages',content_rowid='id',tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS passages_ai AFTER INSERT ON passages BEGIN INSERT INTO passages_fts(rowid,section,text) VALUES(new.id,new.section,new.text); END;
      CREATE TRIGGER IF NOT EXISTS passages_ad AFTER DELETE ON passages BEGIN INSERT INTO passages_fts(passages_fts,rowid,section,text) VALUES('delete',old.id,old.section,old.text); END;
      CREATE TABLE IF NOT EXISTS vectors(passage_id INTEGER PRIMARY KEY REFERENCES passages(id) ON DELETE CASCADE,model TEXT NOT NULL,scale REAL NOT NULL,data BLOB NOT NULL);
    `);
    this.db.pragma(`user_version = ${SCHEMA}`);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  meta<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }
  setMeta(key: string, value: unknown) {
    this.db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }
  /**
   * Counts passage and vector changes so another process (the app while a
   * command-line pass runs, or the other way round) notices them. Removals here
   * drop the in-memory codes; added vectors were already added to them.
   */
  private bump(removed: boolean) {
    const stamp = (this.meta<number>("stamp") || 0) + 1;
    this.setMeta("stamp", stamp);
    if (removed) this.codes = null;
    else if (this.codes) this.codes.stamp = stamp;
  }

  docs(): Map<string, DocRow> {
    return new Map((this.db.prepare("SELECT hash,chunker,status FROM docs").all() as DocRow[]).map((d) => [d.hash, d]));
  }
  /** Replace a PDF's passages. A failure or a scan stores no passages but is remembered so it is not retried every pass. */
  saveDoc(hash: string, chunker: string, title: string, result: Split | { status: "failed"; message: string }) {
    this.transaction(() => {
      if (this.db.prepare("DELETE FROM passages WHERE hash=?").run(hash).changes) this.bump(true);
      if ("status" in result) {
        this.db.prepare("INSERT OR REPLACE INTO docs(hash,chunker,status,title,message,extracted_at) VALUES(?,?,?,?,?,?)").run(hash, chunker, "failed", title, result.message, now());
        return;
      }
      const status = result.chunks.length ? "ok" : "empty";
      this.db.prepare("INSERT OR REPLACE INTO docs VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(hash, chunker, status, result.pages, result.chars, result.chunks.length, result.referencesExcluded ? 1 : 0, title, null, now());
      const insert = this.db.prepare("INSERT INTO passages(hash,seq,page_start,page_end,section,text) VALUES(?,?,?,?,?,?)");
      for (const c of result.chunks) insert.run(hash, c.seq, c.pageStart, c.pageEnd, c.section, c.text);
      if (result.chunks.length) this.bump(false);
    });
  }
  deleteDocs(hashes: string[]) {
    if (!hashes.length) return;
    this.transaction(() => {
      const json = JSON.stringify(hashes);
      this.db.prepare("DELETE FROM passages WHERE hash IN (SELECT value FROM json_each(?))").run(json);
      this.db.prepare("DELETE FROM docs WHERE hash IN (SELECT value FROM json_each(?))").run(json);
      this.bump(true);
    });
  }
  /** Passages after `after` that have no vector from `model`, in id order so a pass resumes where it stopped. */
  pending(model: string, after: number, limit: number): PendingPassage[] {
    return this.db.prepare(
      `SELECT p.id,d.title,p.section,p.text FROM passages p JOIN docs d ON d.hash=p.hash LEFT JOIN vectors v ON v.passage_id=p.id
       WHERE p.id>? AND (v.passage_id IS NULL OR v.model!=?) ORDER BY p.id LIMIT ?`,
    ).all(after, model, limit) as PendingPassage[];
  }
  saveVectors(model: string, rows: { id: number; vector: Float32Array }[]) {
    const insert = this.db.prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?)");
    this.transaction(() => {
      for (const row of rows) {
        const { scale, data } = quantize(row.vector);
        // The passage may have been replaced while its batch was embedding.
        if (this.db.prepare("SELECT 1 FROM passages WHERE id=?").get(row.id)) insert.run(row.id, model, scale, data);
      }
    });
    if (this.codes?.model === model) this.addCodes(rows);
    this.bump(false);
  }
  /** Vectors from another model can never be compared with this one's; drop them when the model changes. */
  dropOtherModels(model: string) {
    if (this.db.prepare("DELETE FROM vectors WHERE model!=?").run(model).changes) this.bump(true);
  }
  counts(model: string | null) {
    const docs = this.db.prepare("SELECT status,count(*) AS n,sum(chunks) AS chunks FROM docs GROUP BY status").all() as { status: string; n: number; chunks: number | null }[];
    const by = (status: string) => docs.find((d) => d.status === status)?.n || 0;
    const passages = (this.db.prepare("SELECT count(*) AS n FROM passages").get() as { n: number }).n;
    const embedded = model ? (this.db.prepare("SELECT count(*) AS n FROM vectors WHERE model=?").get(model) as { n: number }).n : 0;
    return { ok: by("ok"), empty: by("empty"), failed: by("failed"), docs: docs.reduce((n, d) => n + d.n, 0), passages, embedded };
  }
  passages(ids: number[]): Map<number, PassageRow> {
    if (!ids.length) return new Map();
    return new Map(
      (this.db.prepare("SELECT id,hash,seq,page_start,page_end,section,text FROM passages WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as PassageRow[])
        .map((p) => [p.id, p]),
    );
  }
  idsOf(hashes: string[]): number[] {
    if (!hashes.length) return [];
    return (this.db.prepare("SELECT id FROM passages WHERE hash IN (SELECT value FROM json_each(?))").all(JSON.stringify(hashes)) as { id: number }[]).map((r) => r.id);
  }
  /** BM25 over passage text (section headings weigh double); `query` is an FTS5 expression from ftsQuery. */
  lexical(query: string, limit: number): { id: number; hash: string }[] {
    return this.db.prepare(
      "SELECT f.rowid AS id,p.hash FROM passages_fts f JOIN passages p ON p.id=f.rowid WHERE passages_fts MATCH ? ORDER BY bm25(passages_fts,2.0,1.0) LIMIT ?",
    ).all(query, limit) as { id: number; hash: string }[];
  }

  // ---- meaning search ----
  private loadCodes(model: string) {
    // The mean of a sample is enough to centre the bits; the full pass streams rows instead of holding every vector.
    const sample = this.db.prepare("SELECT scale,data FROM vectors WHERE model=? AND passage_id%17=0 LIMIT 20000").all(model) as { scale: number; data: Uint8Array }[];
    const dim = sample[0]?.data.byteLength || WORDS * 32;
    const mean = new Float32Array(dim);
    for (const row of sample) {
      const q = int8(row.data);
      for (let i = 0; i < dim; i++) mean[i] += q[i] * row.scale;
    }
    if (sample.length) for (let i = 0; i < dim; i++) mean[i] /= sample.length;
    const count = (this.db.prepare("SELECT count(*) AS n FROM vectors WHERE model=?").get(model) as { n: number }).n;
    this.codes = { model, stamp: this.meta<number>("stamp") || 0, loadedAt: Date.now(), ids: new Int32Array(Math.max(1024, count)), bits: new Uint32Array(Math.max(1024, count) * WORDS), mean, size: 0 };
    for (const row of this.db.prepare("SELECT passage_id AS id,scale,data FROM vectors WHERE model=?").iterate(model) as Iterable<{ id: number; scale: number; data: Uint8Array }>)
      this.pushCode(row.id, int8(row.data), row.scale);
  }
  private pushCode(id: number, values: ArrayLike<number>, scale: number) {
    const codes = this.codes!;
    if (codes.size === codes.ids.length) {
      const ids = new Int32Array(codes.ids.length * 2);
      ids.set(codes.ids);
      const bits = new Uint32Array(codes.bits.length * 2);
      bits.set(codes.bits);
      codes.ids = ids;
      codes.bits = bits;
    }
    const offset = codes.size * WORDS;
    for (let w = 0; w < WORDS; w++) codes.bits[offset + w] = 0;
    // Sign bits of the vector minus the corpus mean: centring keeps the bits informative.
    for (let i = 0; i < Math.min(values.length, WORDS * 32); i++)
      if (values[i] * scale > codes.mean[i]) codes.bits[offset + (i >>> 5)] |= 1 << (i & 31);
    codes.ids[codes.size++] = id;
  }
  private addCodes(rows: { id: number; vector: Float32Array }[]) {
    for (const row of rows) this.pushCode(row.id, row.vector, 1);
  }
  /**
   * Passages closest in meaning to a normalized query vector: a Hamming scan over
   * sign bits keeps `candidates`, which are rescored with their int8 vectors.
   */
  semantic(model: string, query: Float32Array, k: number, accept: (id: number) => boolean, candidates = 3000): { id: number; score: number }[] {
    // Vectors another process added show up within minutes; reloading costs seconds per million passages.
    const stale = this.codes && this.codes.stamp !== (this.meta<number>("stamp") || 0) && Date.now() - this.codes.loadedAt > 5 * 60 * 1000;
    if (!this.codes || this.codes.model !== model || stale) this.loadCodes(model);
    const codes = this.codes!;
    if (!codes.size || query.length !== codes.mean.length) return [];
    const q = new Uint32Array(WORDS);
    for (let i = 0; i < Math.min(query.length, WORDS * 32); i++) if (query[i] > codes.mean[i]) q[i >>> 5] |= 1 << (i & 31);
    const distance = new Uint16Array(codes.size);
    const histogram = new Uint32Array(WORDS * 32 + 2);
    for (let row = 0; row < codes.size; row++) {
      let d = 0;
      const offset = row * WORDS;
      for (let w = 0; w < WORDS; w++) d += popcount(codes.bits[offset + w] ^ q[w]);
      if (!accept(codes.ids[row])) d = WORDS * 32 + 1;
      distance[row] = d;
      histogram[d]++;
    }
    let cut = 0;
    for (let seen = 0; cut <= WORDS * 32 && seen < candidates; cut++) seen += histogram[cut];
    const picked: number[] = [];
    for (let row = 0; row < codes.size && picked.length < candidates * 1.5; row++) if (distance[row] < cut) picked.push(codes.ids[row]);
    const rows = this.db.prepare("SELECT passage_id AS id,scale,data FROM vectors WHERE model=? AND passage_id IN (SELECT value FROM json_each(?))")
      .all(model, JSON.stringify(picked)) as { id: number; scale: number; data: Uint8Array }[];
    const scored = rows.map((row) => {
      const v = int8(row.data);
      let dot = 0, norm = 0;
      for (let i = 0; i < v.length; i++) {
        dot += v[i] * query[i];
        norm += v[i] * v[i];
      }
      return { id: row.id, score: norm ? dot / Math.sqrt(norm) : 0 };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
