import type { Library } from "./database";
import { deselectWorks, forgetWorks, restoreNavigation } from "../../shared/navigation";
import {
  AppError,
  type Run,
  type SeedProfile,
  type LibraryState,
  type Evidence,
} from "../../shared/types";

/** The trashed works a deletion targets: the selection, or the whole trash of the project. */
export function trashTargets(db: Library, projectId: string, selected?: string[]) {
  db.project(projectId);
  const trash = new Set(
    (
      db.db
        .prepare(
          "SELECT work_id AS id FROM project_works WHERE project_id=? AND json_extract(state,'$.screening')='trash'",
        )
        .all(projectId) as { id: string }[]
    ).map((row) => row.id),
  );
  const ids = [...new Set(selected ?? trash)];
  if (ids.some((id) => !trash.has(id)))
    throw new AppError(
      "NOT_IN_TRASH",
      "휴지통에 있는 문헌만 영구 삭제할 수 있습니다. 목록을 새로 확인하세요.",
    );
  return ids;
}

/**
 * Deletes the records of the given works that nothing uses any more: no
 * project, exploration, collection, shelf file or the `referenced` set (works
 * that seeds and run histories still name). PDF files are never touched.
 */
export function purgeUnreferencedWorks(db: Library, ids: Iterable<string>, referenced: Set<string>) {
  let purged = 0;
  for (const id of ids) {
    if (
      referenced.has(id) ||
      db.db
        .prepare(
          // Shelf papers belong to the app-wide shelf: removing them from a project keeps the record.
          "SELECT 1 FROM project_works WHERE work_id=? UNION ALL SELECT 1 FROM candidates WHERE work_id=? UNION ALL SELECT 1 FROM collection_works WHERE work_id=? UNION ALL SELECT 1 FROM shelf_files WHERE work_id=? LIMIT 1",
        )
        .get(id, id, id, id)
    )
      continue;
    for (const table of ["identifiers", "metadata_snapshots", "attachments"])
      db.db.prepare(`DELETE FROM ${table} WHERE work_id=?`).run(id);
    db.db.prepare("DELETE FROM citations WHERE citing_id=?").run(id);
    db.db
      .prepare("UPDATE import_items SET work_id=NULL WHERE work_id=?")
      .run(id);
    db.db.prepare("DELETE FROM works WHERE id=?").run(id);
    purged++;
  }
  return purged;
}

// Removal is project-scoped and keeps shared records, shelf papers included.
// No PDF file is touched.
export function deleteTrashedWorks(
  db: Library,
  projectId: string,
  selected?: string[],
) {
  return db.transaction(() => {
    const ids = trashTargets(db, projectId, selected);
    if (!ids.length) return { ids };
    const removed = new Set(ids);
    const keep = (values: string[]) => values.filter((id) => !removed.has(id));
    const otherReferences = new Set<string>();

    for (const row of db.db
      .prepare("SELECT id,project_id,data FROM seed_profiles")
      .all() as { id: string; project_id: string; data: string }[]) {
      const seed = JSON.parse(row.data) as SeedProfile;
      if (row.project_id !== projectId) {
        for (const id of [...seed.ids, ...Object.values(seed.groups).flat()])
          otherReferences.add(id);
        continue;
      }
      seed.ids = keep(seed.ids);
      for (const group of Object.keys(seed.groups))
        seed.groups[group] = keep(seed.groups[group]);
      db.db
        .prepare("UPDATE seed_profiles SET data=? WHERE id=?")
        .run(JSON.stringify(seed), row.id);
    }
    for (const id of ids) {
      db.db.prepare("DELETE FROM chat_threads WHERE project_id=? AND work_id=?").run(projectId, id);
      db.db.prepare("DELETE FROM preferences WHERE key=?").run(`article-chat:${JSON.stringify([projectId, id])}`);
      db.db
        .prepare(
          "DELETE FROM candidates WHERE work_id=? AND run_id IN (SELECT id FROM runs WHERE project_id=?)",
        )
        .run(id, projectId);
      db.db
        .prepare(
          "DELETE FROM collection_works WHERE work_id=? AND collection_id IN (SELECT id FROM collections WHERE project_id=?)",
        )
        .run(id, projectId);
      db.db
        .prepare("DELETE FROM project_works WHERE project_id=? AND work_id=?")
        .run(projectId, id);
      db.db
        .prepare(
          "UPDATE import_items SET work_id=NULL WHERE work_id=? AND run_id IN (SELECT id FROM runs WHERE project_id=?)",
        )
        .run(id, projectId);
    }
    // Read all runs: the UI's runs() method intentionally limits history to 100.
    for (const row of db.db.prepare("SELECT data FROM runs").all() as {
      data: string;
    }[]) {
      const run = JSON.parse(row.data) as Run;
      if (run.projectId !== projectId) {
        for (const id of run.inputIds) otherReferences.add(id);
        for (const task of run.tasks)
          if (task.seedId) otherReferences.add(task.seedId);
        if (run.import?.workId) otherReferences.add(run.import.workId);
        continue;
      }
      run.inputIds = keep(run.inputIds);
      if (run.download) {
        for (const item of run.download.items) {
          if (removed.has(item.workId)) {
            item.status = "skipped";
            item.message = "아카이브에서 영구 삭제된 문헌";
          }
        }
      }
      run.tasks = run.tasks.filter(
        (task) => !task.seedId || !removed.has(task.seedId),
      );
      if (run.import?.workId && removed.has(run.import.workId)) {
        // A paused attachment import must never resume against a deleted target.
        run.status = "cancelled";
        run.import.paths = [];
        run.import.index = 0;
        delete run.import.workId;
      }
      run.count = (
        db.db
          .prepare("SELECT count(*) AS n FROM candidates WHERE run_id=?")
          .get(run.id) as { n: number }
      ).n;
      db.saveRun(run);
    }
    for (const row of db.db
      .prepare(
        "SELECT c.run_id,c.work_id,c.evidence,r.project_id FROM candidates c JOIN runs r ON r.id=c.run_id",
      )
      .all() as {
      run_id: string;
      work_id: string;
      evidence: string;
      project_id: string;
    }[]) {
      const evidence = JSON.parse(row.evidence) as Evidence;
      if (row.project_id !== projectId) {
        for (const id of evidence.seedIds) otherReferences.add(id);
      } else if (evidence.seedIds.some((id) => removed.has(id))) {
        evidence.seedIds = keep(evidence.seedIds);
        db.db
          .prepare(
            "UPDATE candidates SET evidence=? WHERE run_id=? AND work_id=?",
          )
          .run(JSON.stringify(evidence), row.run_id, row.work_id);
      }
    }
    // Keep undo for unrelated edits, but never let it recreate deleted membership.
    for (const row of db.db
      .prepare("SELECT id,data FROM changes WHERE project_id=?")
      .all(projectId) as { id: number; data: string }[]) {
      const before = JSON.parse(row.data) as {
        id: string;
        state: LibraryState;
      }[];
      const remaining = before.filter((item) => !removed.has(item.id));
      if (remaining.length)
        db.db
          .prepare("UPDATE changes SET data=? WHERE id=?")
          .run(JSON.stringify(remaining), row.id);
      else db.db.prepare("DELETE FROM changes WHERE id=?").run(row.id);
    }
    // Merge snapshots contain complete old tables; discard them after irreversible deletion.
    db.db.prepare("DELETE FROM merge_history").run();
    purgeUnreferencedWorks(db, ids, otherReferences);
    db.touch();
    const ui = db.pref<Record<string, unknown>>("ui:" + projectId) || {};
    db.pref("ui:" + projectId, {
      ...ui,
      navigation: forgetWorks(restoreNavigation(ui), ids),
    });
    return { ids };
  });
}

/** Saved UI state whose remembered selections match the trash: trashed papers leave other views, restored ones leave the trash view. */
export function settledUi(db: Library, projectId: string): Record<string, unknown> {
  const ui = db.pref<Record<string, unknown>>("ui:" + projectId) || {};
  const navigation = restoreNavigation(ui);
  const views = Object.values(navigation.views);
  const selected = [...new Set(views.flatMap((view) => view.selected))];
  if (!selected.length) return ui;
  const trashed = new Set(
    (
      db.db
        .prepare(
          "SELECT work_id AS id FROM project_works WHERE project_id=? AND work_id IN (SELECT value FROM json_each(?)) AND json_extract(state,'$.screening')='trash'",
        )
        .all(projectId, JSON.stringify(selected)) as { id: string }[]
    ).map((row) => row.id),
  );
  const restored = views
    .filter((view) => view.scope === "trash")
    .flatMap((view) => view.selected.filter((id) => !trashed.has(id)));
  if (!trashed.size && !restored.length) return ui;
  return {
    ...ui,
    navigation: deselectWorks(deselectWorks(navigation, [...trashed], false), restored, true),
  };
}
