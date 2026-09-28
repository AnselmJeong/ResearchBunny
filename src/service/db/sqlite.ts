import { Database as BunDatabase } from "bun:sqlite";

/** Preserve the library's SQL contract while using Bun's bundled SQLite. */
export default class Database extends BunDatabase {
  constructor(path: string, options: { readonly?: boolean } = {}) {
    super(path, { ...options, strict: true, create: !options.readonly });
  }
  pragma(sql: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.query<Record<string, unknown>, []>(`PRAGMA ${sql}`).all();
    return options.simple ? Object.values(rows[0] ?? {})[0] : rows;
  }
  async backup(path: string): Promise<void> {
    // SQLite creates a consistent standalone snapshot, including committed WAL data.
    this.query("VACUUM INTO ?").run(path);
  }
}
