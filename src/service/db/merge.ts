import { type Library } from "./database";
import {
  AppError,
  type LibraryState,
  type Work,
  type SeedProfile,
  type Run,
  type Attachment,
} from "../../shared/types";

type Row = Record<string, string | number | null>;
/** Tables whose rows belong to one work: the column that names it. */
const OWNED: [table: string, column: string][] = [
  ["project_works", "work_id"],
  ["archive_topic_works", "work_id"],
  ["collection_works", "work_id"],
  ["genealogy_papers", "work_id"],
  ["attachments", "work_id"],
  ["identifiers", "work_id"],
  ["metadata_snapshots", "work_id"],
  ["citations", "citing_id"],
  ["candidates", "work_id"],
];
/**
 * What one merge changed, and nothing else: the two works and their own rows as
 * they were, and for rows shared with other works (runs, seed profiles, chats)
 * the value before and after. Undo puts back only these, so work done since on
 * other papers, reports and runs is left alone.
 */
interface MergeRecord {
  v: 2;
  keepId: string;
  removeId: string;
  works: Row[];
  owned: Record<string, Row[]>;
  runs: { id: string; before: string; after: string }[];
  seeds: { id: string; before: string; after: string }[];
  importItems: string[];
  chats: { threads: string[]; heads: { scope: string; thread_id: string }[]; movedHeads: string[]; legacy: { from: string; to: string }[] };
  shelf: { files: { id: string; work_id: string }[]; embeddings: Record<string, string | number>[] };
}
/** Tables the first format copied whole; kept so a merge made by an older version can still be undone. */
const LEGACY_TABLES = [
  "works", "identifiers", "metadata_snapshots", "projects", "project_works", "collections", "collection_works",
  "archive_topics", "archive_topic_works", "seed_profiles", "citations", "runs", "candidates", "attachments",
  "changes", "import_items", "export_records", "genealogy_papers",
];
const empty = (value: unknown) =>
  value === null || value === undefined || value === "" ||
  (Array.isArray(value) && !value.length) ||
  (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length);

/** The surviving record: its own values first, the removed record's wherever it has none. */
function mergedWork(keep: Work, remove: Work): Work {
  const merged = { ...remove, ...keep } as Record<string, unknown>;
  for (const [key, value] of Object.entries(remove))
    if (empty(merged[key]) && !empty(value)) merged[key] = value;
  return {
    ...(merged as unknown as Work),
    id: keep.id,
    citekey: keep.citekey,
    // A record without provider data carries the placeholder type; the provider's is the known one.
    type: keep.openalex || !remove.openalex || Object.hasOwn(keep.edits, "type") ? keep.type : remove.type,
    retracted: keep.retracted || remove.retracted,
    references: keep.references || remove.references
      ? [...new Set([...(keep.references || []), ...(remove.references || [])])]
      : null,
    related: [...new Set([...(keep.related || []), ...(remove.related || [])])],
    bibFields: keep.bibFields || remove.bibFields ? { ...remove.bibFields, ...keep.bibFields } : undefined,
    edits: { ...remove.edits, ...keep.edits },
  };
}

export function mergeWorks(db: Library, keepId: string, removeId: string) {
  if (keepId === removeId)
    throw new AppError("INVALID", "서로 다른 문헌을 선택하세요.");
  const keep = db.get(keepId),
    remove = db.get(removeId);
  const sql = db.db;
  db.transaction(() => {
    const record: MergeRecord = {
      v: 2,
      keepId,
      removeId,
      works: sql.prepare("SELECT rowid,* FROM works WHERE id IN (?,?)").all(keepId, removeId) as Row[],
      owned: Object.fromEntries(OWNED.map(([table, column]) => [table, sql.prepare(`SELECT * FROM ${table} WHERE ${column} IN (?,?)`).all(keepId, removeId) as Row[]])),
      runs: [],
      seeds: [],
      importItems: (sql.prepare("SELECT id FROM import_items WHERE work_id=?").all(removeId) as { id: string }[]).map((r) => r.id),
      chats: { threads: [], heads: [], movedHeads: [], legacy: [] },
      // Shelf rows are large (vectors); only the two works' rows are kept.
      shelf: {
        files: sql.prepare("SELECT id,work_id FROM shelf_files WHERE work_id IN (?,?)").all(keepId, removeId) as { id: string; work_id: string }[],
        embeddings: (sql.prepare("SELECT * FROM work_embeddings WHERE work_id IN (?,?)").all(keepId, removeId) as Record<string, unknown>[])
          .map((r) => ({ ...r, vector: Buffer.from(r.vector as Uint8Array).toString("base64") })) as Record<string, string | number>[],
      },
    };
    const states = sql
      .prepare("SELECT project_id,state FROM project_works WHERE work_id=?")
      .all(removeId) as { project_id: string; state: string }[];
    const member = sql.prepare("SELECT 1 FROM project_works WHERE project_id=? AND work_id=?");
    for (const r of states) {
      const s = JSON.parse(r.state) as LibraryState;
      // Where only the removed record was in the project, its state is the paper's state there.
      const k = member.get(r.project_id, keepId) ? db.state(r.project_id, keepId) : null;
      db.mutate(
        r.project_id,
        [keepId],
        k
          ? {
              ...s,
              ...k,
              screening: [s.screening, k.screening].includes("included")
                ? "included"
                : k.screening,
              note: [k.note, s.note].filter(Boolean).join("\n\n"),
              tags: [...new Set([...k.tags, ...s.tags])],
              starred: k.starred || s.starred,
            }
          : s,
        false,
      );
      // mutate() records the state before a move to the trash; the removed record already knew it.
      if (!k && s.screening === "trash")
        sql.prepare("UPDATE project_works SET state=? WHERE project_id=? AND work_id=?").run(r.state, r.project_id, keepId);
    }
    sql.prepare("INSERT OR IGNORE INTO archive_topic_works(project_id,work_id,topic_id) SELECT project_id,?,topic_id FROM archive_topic_works WHERE work_id=?").run(keepId, removeId);
    sql.prepare("DELETE FROM project_works WHERE work_id=?").run(removeId);
    sql.prepare("INSERT OR IGNORE INTO collection_works SELECT collection_id,? FROM collection_works WHERE work_id=?").run(keepId, removeId);
    sql.prepare("DELETE FROM collection_works WHERE work_id=?").run(removeId);
    // A genealogy keeps the paper and its card under the surviving record.
    sql.prepare("INSERT OR IGNORE INTO genealogy_papers(genealogy_id,work_id,data,card) SELECT genealogy_id,?,data,card FROM genealogy_papers WHERE work_id=?").run(keepId, removeId);
    sql.prepare("DELETE FROM genealogy_papers WHERE work_id=?").run(removeId);
    for (const a of db.attachments(removeId)) {
      const updated: Attachment = { ...a, workId: keepId };
      db.saveAttachment(updated);
    }
    sql.prepare("UPDATE identifiers SET work_id=? WHERE work_id=?").run(keepId, removeId);
    sql.prepare("UPDATE metadata_snapshots SET work_id=? WHERE work_id=?").run(keepId, removeId);
    sql.prepare("INSERT OR IGNORE INTO citations SELECT ?,cited_external FROM citations WHERE citing_id=?").run(keepId, removeId);
    sql.prepare("DELETE FROM citations WHERE citing_id=?").run(removeId);
    sql.prepare("INSERT OR IGNORE INTO candidates SELECT run_id,?,evidence,rank FROM candidates WHERE work_id=?").run(keepId, removeId);
    sql.prepare("DELETE FROM candidates WHERE work_id=?").run(removeId);
    const replace = (ids: string[]) => [
      ...new Set(ids.map((id) => (id === removeId ? keepId : id))),
    ];
    // Only rows that name the removed work are rewritten; the rest keep their bytes and their dates.
    const naming = `%${removeId}%`;
    for (const row of sql
      .prepare("SELECT id,data FROM seed_profiles WHERE data LIKE ?")
      .all(naming) as { id: string; data: string }[]) {
      const p = JSON.parse(row.data) as SeedProfile;
      p.ids = replace(p.ids);
      for (const group of Object.keys(p.groups))
        p.groups[group] = replace(p.groups[group]);
      const after = JSON.stringify(p);
      if (after === row.data) continue;
      sql.prepare("UPDATE seed_profiles SET data=? WHERE id=?").run(after, row.id);
      record.seeds.push({ id: row.id, before: row.data, after });
    }
    for (const row of sql.prepare("SELECT id,data FROM runs WHERE data LIKE ?").all(naming) as { id: string; data: string }[]) {
      const run = JSON.parse(row.data) as Run;
      run.inputIds = replace(run.inputIds);
      if (run.download) {
        const items = new Map<string, (typeof run.download.items)[number]>();
        for (const item of run.download.items) {
          const workId = item.workId === removeId ? keepId : item.workId;
          const prior = items.get(workId);
          if (!prior || ["completed", "existing"].includes(item.status))
            items.set(workId, { ...item, workId, title: workId === keepId ? keep.title : item.title });
        }
        run.download.items = [...items.values()];
        run.total = run.download.items.length;
        run.count = run.download.items.filter(i => ["completed", "existing"].includes(i.status)).length;
      }
      for (const task of run.tasks)
        if (task.seedId === removeId) task.seedId = keepId;
      if (JSON.stringify(run) === row.data) continue;
      db.saveRun(run);
      record.runs.push({ id: row.id, before: row.data, after: JSON.stringify(run) });
    }
    // Conversations about the removed record continue under the surviving one.
    record.chats.threads = (sql.prepare("SELECT id FROM chat_threads WHERE work_id=?").all(removeId) as { id: string }[]).map((r) => r.id);
    if (record.chats.threads.length) {
      const moved = JSON.stringify(record.chats.threads);
      record.chats.heads = sql.prepare("SELECT scope,thread_id FROM chat_heads WHERE thread_id IN (SELECT value FROM json_each(?))").all(moved) as { scope: string; thread_id: string }[];
      sql.prepare("UPDATE chat_threads SET work_id=?,data=json_set(data,'$.workId',?) WHERE work_id=?").run(keepId, keepId, removeId);
      for (const head of record.chats.heads) {
        const [projectId, , context] = JSON.parse(head.scope) as [string, string, string];
        const scope = JSON.stringify([projectId, keepId, context]);
        // The surviving record's current conversation stays current; the moved ones are in its list.
        if (sql.prepare("INSERT OR IGNORE INTO chat_heads VALUES(?,?)").run(scope, head.thread_id).changes) record.chats.movedHeads.push(scope);
        sql.prepare("DELETE FROM chat_heads WHERE scope=?").run(head.scope);
      }
    }
    for (const row of sql.prepare("SELECT key FROM preferences WHERE key LIKE 'article-chat:%' AND key LIKE ?").all(naming) as { key: string }[]) {
      const [projectId, workId] = JSON.parse(row.key.slice("article-chat:".length)) as [string, string];
      const to = `article-chat:${JSON.stringify([projectId, keepId])}`;
      if (workId !== removeId || sql.prepare("SELECT 1 FROM preferences WHERE key=?").get(to)) continue;
      sql.prepare("UPDATE preferences SET key=? WHERE key=?").run(to, row.key);
      record.chats.legacy.push({ from: row.key, to });
    }
    sql.prepare("UPDATE works SET data=? WHERE id=?").run(JSON.stringify(mergedWork(keep, remove)), keepId);
    sql.prepare("UPDATE shelf_files SET work_id=? WHERE work_id=?").run(keepId, removeId);
    sql.prepare("UPDATE OR IGNORE work_embeddings SET work_id=? WHERE work_id=?").run(keepId, removeId);
    sql.prepare("DELETE FROM work_embeddings WHERE work_id=?").run(removeId);
    sql.prepare("DELETE FROM shelf_fts WHERE rowid=(SELECT rowid FROM works WHERE id=?)").run(removeId);
    sql.prepare("DELETE FROM works WHERE id=?").run(removeId);
    sql.prepare("UPDATE import_items SET work_id=? WHERE work_id=?").run(keepId, removeId);
    db.touch();
    sql
      .prepare("INSERT OR REPLACE INTO merge_history VALUES(1,?,?)")
      .run(JSON.stringify(record), db.pref<number>("revision") ?? 0);
  });
}

const insert = (db: Library, table: string, row: Row) =>
  db.db
    .prepare(`INSERT OR REPLACE INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));

function restoreShelf(db: Library, ids: string[], shelf: MergeRecord["shelf"]) {
  for (const f of shelf.files)
    db.db.prepare("UPDATE shelf_files SET work_id=? WHERE id=?").run(f.work_id, f.id);
  for (const id of ids)
    db.db.prepare("DELETE FROM work_embeddings WHERE work_id=?").run(id);
  for (const e of shelf.embeddings)
    db.db.prepare("INSERT OR REPLACE INTO work_embeddings VALUES(?,?,?,?,?,?,?,?)")
      .run(e.work_id, e.model, e.prompt, e.basis, e.text_hash, e.dim, Buffer.from(String(e.vector), "base64"), e.created_at);
}

export function undoMerge(db: Library): boolean {
  const row = db.db
    .prepare("SELECT data,revision FROM merge_history WHERE id=1")
    .get() as { data: string; revision: number } | undefined;
  if (!row) return false;
  if (row.revision !== db.pref("revision"))
    throw new AppError(
      "LATER_EDITS",
      "병합 이후 변경이 있어 자동 되돌리기를 중단했습니다. 자료 손실을 막기 위해 백업을 사용하세요.",
    );
  const saved = JSON.parse(row.data) as MergeRecord | (Record<string, Row[]> & { v?: undefined; __shelf?: { ids: string[]; files: { id: string; work_id: string }[]; embeddings: Record<string, string | number>[] } });
  const sql = db.db;
  sql.pragma("foreign_keys=OFF");
  try {
    db.transaction(() => {
      if (saved.v === 2) {
        const { keepId, removeId } = saved;
        for (const [table, column] of OWNED) {
          sql.prepare(`DELETE FROM ${table} WHERE ${column} IN (?,?)`).run(keepId, removeId);
          for (const r of saved.owned[table] || []) insert(db, table, r);
        }
        // With its rowid, so the search index rows of other works still point at them.
        for (const work of saved.works) insert(db, "works", work);
        // A run or seed profile that moved on since keeps its newer state.
        for (const run of saved.runs)
          sql.prepare("UPDATE runs SET data=? WHERE id=? AND data=?").run(run.before, run.id, run.after);
        for (const seed of saved.seeds)
          sql.prepare("UPDATE seed_profiles SET data=? WHERE id=? AND data=?").run(seed.before, seed.id, seed.after);
        sql.prepare("UPDATE import_items SET work_id=? WHERE id IN (SELECT value FROM json_each(?))").run(removeId, JSON.stringify(saved.importItems));
        sql.prepare("UPDATE chat_threads SET work_id=?,data=json_set(data,'$.workId',?) WHERE id IN (SELECT value FROM json_each(?))").run(removeId, removeId, JSON.stringify(saved.chats.threads));
        for (const scope of saved.chats.movedHeads) sql.prepare("DELETE FROM chat_heads WHERE scope=?").run(scope);
        for (const head of saved.chats.heads) sql.prepare("INSERT OR REPLACE INTO chat_heads VALUES(?,?)").run(head.scope, head.thread_id);
        for (const pref of saved.chats.legacy) sql.prepare("UPDATE OR IGNORE preferences SET key=? WHERE key=?").run(pref.from, pref.to);
        restoreShelf(db, [keepId, removeId], saved.shelf);
      } else if (Array.isArray(saved.works)) {
        for (const t of [...LEGACY_TABLES].reverse())
          sql.prepare(`DELETE FROM ${t}`).run();
        for (const t of LEGACY_TABLES)
          for (const r of saved[t] || []) insert(db, t, r);
        if (saved.__shelf) restoreShelf(db, saved.__shelf.ids, saved.__shelf);
      }
      sql.prepare("DELETE FROM merge_history").run();
      db.touch();
    });
  } finally {
    sql.pragma("foreign_keys=ON");
  }
  return true;
}
