import { type Library } from "./database";
import {
  AppError,
  type LibraryState,
  type Work,
  type SeedProfile,
  type Run,
  type Attachment,
} from "../../shared/types";
const TABLES = [
  "works",
  "identifiers",
  "metadata_snapshots",
  "projects",
  "project_works",
  "collections",
  "collection_works",
  "archive_topics",
  "archive_topic_works",
  "seed_profiles",
  "citations",
  "runs",
  "candidates",
  "attachments",
  "changes",
  "import_items",
  "export_records",
];
export function mergeWorks(db: Library, keepId: string, removeId: string) {
  if (keepId === removeId)
    throw new AppError("INVALID", "서로 다른 문헌을 선택하세요.");
  const keep = db.get(keepId),
    remove = db.get(removeId);
  db.transaction(() => {
    const snapshot = Object.fromEntries(
      TABLES.map((t) => [t, db.db.prepare(`SELECT * FROM ${t}`).all()]),
    );
    const states = db.db
      .prepare("SELECT project_id,state FROM project_works WHERE work_id=?")
      .all(removeId) as { project_id: string; state: string }[];
    for (const r of states) {
      const s = JSON.parse(r.state) as LibraryState;
      const k = db.state(r.project_id, keepId);
      db.mutate(
        r.project_id,
        [keepId],
        {
          ...s,
          ...k,
          screening: [s.screening, k.screening].includes("included")
            ? "included"
            : k.screening,
          note: [k.note, s.note].filter(Boolean).join("\n\n"),
          tags: [...new Set([...k.tags, ...s.tags])],
          starred: k.starred || s.starred,
        },
        false,
      );
    }
    db.db.prepare("INSERT OR IGNORE INTO archive_topic_works(project_id,work_id,topic_id) SELECT project_id,?,topic_id FROM archive_topic_works WHERE work_id=?").run(keepId, removeId);
    db.db.prepare("DELETE FROM project_works WHERE work_id=?").run(removeId);
    for (const row of db.db
      .prepare("SELECT collection_id FROM collection_works WHERE work_id=?")
      .all(removeId) as { collection_id: string }[])
      db.db
        .prepare("INSERT OR IGNORE INTO collection_works VALUES(?,?)")
        .run(row.collection_id, keepId);
    db.db.prepare("DELETE FROM collection_works WHERE work_id=?").run(removeId);
    for (const a of db.attachments(removeId)) {
      const updated: Attachment = { ...a, workId: keepId };
      db.saveAttachment(updated);
    }
    db.db
      .prepare("UPDATE identifiers SET work_id=? WHERE work_id=?")
      .run(keepId, removeId);
    db.db
      .prepare("UPDATE metadata_snapshots SET work_id=? WHERE work_id=?")
      .run(keepId, removeId);
    for (const row of db.db
      .prepare("SELECT cited_external FROM citations WHERE citing_id=?")
      .all(removeId) as { cited_external: string }[])
      db.db
        .prepare("INSERT OR IGNORE INTO citations VALUES(?,?)")
        .run(keepId, row.cited_external);
    db.db.prepare("DELETE FROM citations WHERE citing_id=?").run(removeId);
    for (const row of db.db
      .prepare("SELECT * FROM candidates WHERE work_id=?")
      .all(removeId) as any[])
      db.db
        .prepare("INSERT OR IGNORE INTO candidates VALUES(?,?,?,?)")
        .run(row.run_id, keepId, row.evidence, row.rank);
    db.db.prepare("DELETE FROM candidates WHERE work_id=?").run(removeId);
    const replace = (ids: string[]) => [
      ...new Set(ids.map((id) => (id === removeId ? keepId : id))),
    ];
    for (const row of db.db
      .prepare("SELECT id,data FROM seed_profiles")
      .all() as { id: string; data: string }[]) {
      const p = JSON.parse(row.data) as SeedProfile;
      p.ids = replace(p.ids);
      for (const group of Object.keys(p.groups))
        p.groups[group] = replace(p.groups[group]);
      db.db
        .prepare("UPDATE seed_profiles SET data=? WHERE id=?")
        .run(JSON.stringify(p), row.id);
    }
    for (const run of db.runs()) {
      run.inputIds = replace(run.inputIds);
      for (const task of run.tasks)
        if (task.seedId === removeId) task.seedId = keepId;
      db.saveRun(run as Run);
    }
    const updated: Work = {
      ...remove,
      ...keep,
      doi: keep.doi || remove.doi,
      openalex: keep.openalex || remove.openalex,
      references: [
        ...new Set([...(keep.references || []), ...(remove.references || [])]),
      ],
      bibFields: { ...remove.bibFields, ...keep.bibFields },
    };
    db.db
      .prepare("UPDATE works SET data=? WHERE id=?")
      .run(JSON.stringify(updated), keepId);
    db.db.prepare("DELETE FROM works WHERE id=?").run(removeId);
    db.db
      .prepare("UPDATE import_items SET work_id=? WHERE work_id=?")
      .run(keepId, removeId);
    db.touch();
    db.db
      .prepare("INSERT OR REPLACE INTO merge_history VALUES(1,?,?)")
      .run(JSON.stringify(snapshot), db.pref<number>("revision") ?? 0);
  });
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
  const snapshot = JSON.parse(row.data) as Record<
    string,
    Record<string, string | number | null>[]
  >;
  db.db.pragma("foreign_keys=OFF");
  try {
    db.transaction(() => {
      for (const t of [...TABLES].reverse())
        db.db.prepare(`DELETE FROM ${t}`).run();
      for (const t of TABLES)
        for (const r of snapshot[t] || [])
          db.db
            .prepare(
              `INSERT INTO ${t}(${Object.keys(r).join(",")}) VALUES(${Object.keys(
                r,
              )
                .map(() => "?")
                .join(",")})`,
            )
            .run(...Object.values(r));
      db.db.prepare("DELETE FROM merge_history").run();
      db.touch();
    });
  } finally {
    db.db.pragma("foreign_keys=ON");
  }
  return true;
}
