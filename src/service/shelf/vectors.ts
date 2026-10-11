import type { Library } from "../db/database";
import { now } from "../../shared/types";
import type { EmbedBasis } from "../../shared/shelf";

export const toBlob = (vector: Float32Array) => new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
export function fromBlob(blob: Uint8Array): Float32Array {
  const copy = blob.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/**
 * Exhaustive cosine search over L2-normalized vectors held in one Float32Array.
 * Measured at 6 ms for 8,322 × 768 and 17 ms for 25,000 on an M2 Max, so no
 * approximate index is needed for one vector per paper. Swap this module when
 * the unit becomes PDF chunks.
 */
export class VectorIndex {
  private ids: string[] = [];
  private rows = new Map<string, number>();
  private data = new Float32Array(0);
  dim = 0;
  model = "";
  loaded = false;
  constructor(private db: Library) {}

  get size() {
    return this.ids.length;
  }
  has(id: string) {
    return this.rows.has(id);
  }
  load(model: string) {
    this.ids = [];
    this.rows.clear();
    this.data = new Float32Array(0);
    this.dim = 0;
    this.model = model;
    const rows = this.db.db
      .prepare("SELECT work_id,dim,vector FROM work_embeddings WHERE model=?")
      .all(model) as { work_id: string; dim: number; vector: Uint8Array }[];
    for (const row of rows) this.put(row.work_id, fromBlob(row.vector));
    this.loaded = true;
  }
  ensure(model: string) {
    if (!this.loaded || this.model !== model) this.load(model);
  }
  vector(id: string): Float32Array | null {
    const row = this.rows.get(id);
    return row === undefined ? null : this.data.slice(row * this.dim, (row + 1) * this.dim);
  }
  private put(id: string, vector: Float32Array) {
    if (!this.dim) this.dim = vector.length;
    if (vector.length !== this.dim) return;
    let row = this.rows.get(id);
    if (row === undefined) {
      row = this.ids.length;
      if ((row + 1) * this.dim > this.data.length) {
        const grown = new Float32Array(Math.max(this.dim * 256, this.data.length * 2));
        grown.set(this.data);
        this.data = grown;
      }
      this.ids.push(id);
      this.rows.set(id, row);
    }
    this.data.set(vector, row * this.dim);
  }
  upsert(id: string, vector: Float32Array) {
    this.put(id, vector);
  }
  remove(id: string) {
    const row = this.rows.get(id);
    if (row === undefined) return;
    const last = this.ids.length - 1;
    if (row !== last) {
      const moved = this.ids[last];
      this.data.copyWithin(row * this.dim, last * this.dim, (last + 1) * this.dim);
      this.ids[row] = moved;
      this.rows.set(moved, row);
    }
    this.ids.pop();
    this.rows.delete(id);
  }
  search(query: Float32Array, k: number, accept: (id: string) => boolean = () => true): { id: string; score: number }[] {
    if (!this.dim || query.length !== this.dim || k <= 0) return [];
    const top: { id: string; score: number }[] = [];
    const dim = this.dim, data = this.data;
    for (let row = 0; row < this.ids.length; row++) {
      let dot = 0;
      const offset = row * dim;
      for (let i = 0; i < dim; i++) dot += data[offset + i] * query[i];
      if (top.length === k && dot <= top[k - 1].score) continue;
      const id = this.ids[row];
      if (!accept(id)) continue;
      let at = top.length;
      while (at > 0 && top[at - 1].score < dot) at--;
      top.splice(at, 0, { id, score: dot });
      if (top.length > k) top.pop();
    }
    return top;
  }
  save(workId: string, model: string, prompt: string, basis: EmbedBasis, textHash: string, vector: Float32Array) {
    this.db.db
      .prepare("INSERT INTO work_embeddings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(work_id,model) DO UPDATE SET prompt=excluded.prompt,basis=excluded.basis,text_hash=excluded.text_hash,dim=excluded.dim,vector=excluded.vector,created_at=excluded.created_at")
      .run(workId, model, prompt, basis, textHash, vector.length, toBlob(vector), now());
    if (this.loaded && this.model === model) this.upsert(workId, vector);
  }
  /** Keep the in-memory matrix in step after merges or deletions changed rows. */
  forget(workId: string) {
    this.db.db.prepare("DELETE FROM work_embeddings WHERE work_id=?").run(workId);
    this.remove(workId);
  }
}
