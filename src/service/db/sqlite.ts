import { Database as BunDatabase, type Statement } from "bun:sqlite";

/** Preserve the library's SQL contract while using Bun's bundled SQLite. */
export default class Database extends BunDatabase {
  constructor(path: string, options: { readonly?: boolean } = {}) {
    super(path, { ...options, strict: true, create: !options.readonly });
    // bun:sqlite compiles the SQL on every prepare(), and its own query() cache holds 20 statements.
    // The service prepares at each call site, often inside loops, so keep one statement per SQL text.
    const compile = this.prepare.bind(this) as (...args: unknown[]) => Statement;
    this.prepare = ((...args: unknown[]) => {
      // query() calls prepare() with flags; only the plain one-argument form is cached.
      if (args.length !== 1 || typeof args[0] !== "string") return compile(...args);
      let statement = this.statements.get(args[0]);
      if (!statement) {
        statement = compile(args[0]);
        if (this.statements.size < 1000) this.statements.set(args[0], statement);
      }
      return statement;
    }) as BunDatabase["prepare"];
  }
  private statements = new Map<string, Statement>();
  override close(throwOnError?: boolean): void {
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    super.close(throwOnError);
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
