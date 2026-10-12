import type { Library } from "./database";
import { purgeUnreferencedWorks } from "./trash";
import { AppError, type Run, type SeedProfile, type Evidence } from "../../shared/types";

/** Works that seeds and run histories name; their records must stay. */
function historyReferences(db: Library) {
  const ids = new Set<string>();
  for (const row of db.db.prepare("SELECT data FROM seed_profiles").all() as { data: string }[]) {
    const seed = JSON.parse(row.data) as SeedProfile;
    for (const id of [...seed.ids, ...Object.values(seed.groups).flat()]) ids.add(id);
  }
  for (const row of db.db.prepare("SELECT data FROM runs").all() as { data: string }[]) {
    const run = JSON.parse(row.data) as Run;
    for (const id of run.inputIds) ids.add(id);
    for (const task of run.tasks) if (task.seedId) ids.add(task.seedId);
    if (run.import?.workId) ids.add(run.import.workId);
  }
  for (const row of db.db.prepare("SELECT evidence FROM candidates").all() as { evidence: string }[])
    for (const id of (JSON.parse(row.evidence) as Evidence).seedIds) ids.add(id);
  return ids;
}

/**
 * Deletes a project with everything only it holds: paper states and notes,
 * collections, topics, seeds, explorations and imports, chats, undo history
 * and saved views. Papers keep their records while another project, the shelf
 * or a remaining history uses them, and no PDF file is touched.
 */
export function deleteProject(db: Library, projectId: string) {
  return db.transaction(() => {
    db.project(projectId);
    if (db.projects().length < 2)
      throw new AppError("LAST_PROJECT", "프로젝트가 하나뿐이라 삭제할 수 없습니다. 새 프로젝트를 만든 뒤 삭제하세요.");
    const runs = "SELECT id FROM runs WHERE project_id=?";
    const touched = new Set(
      (
        db.db
          .prepare(
            `SELECT work_id AS id FROM project_works WHERE project_id=?
             UNION SELECT work_id FROM candidates WHERE run_id IN (${runs})
             UNION SELECT work_id FROM collection_works WHERE collection_id IN (SELECT id FROM collections WHERE project_id=?)`,
          )
          .all(projectId, projectId, projectId) as { id: string }[]
      ).map((row) => row.id),
    );
    for (const row of db.db.prepare("SELECT data FROM seed_profiles WHERE project_id=?").all(projectId) as { data: string }[]) {
      const seed = JSON.parse(row.data) as SeedProfile;
      for (const id of [...seed.ids, ...Object.values(seed.groups).flat()]) touched.add(id);
    }
    for (const row of db.db.prepare("SELECT data FROM runs WHERE project_id=?").all(projectId) as { data: string }[]) {
      const run = JSON.parse(row.data) as Run;
      for (const id of run.inputIds) touched.add(id);
      for (const task of run.tasks) if (task.seedId) touched.add(task.seedId);
      if (run.import?.workId) touched.add(run.import.workId);
    }
    // Chat contexts and heads follow their threads.
    db.db.prepare("DELETE FROM chat_threads WHERE project_id=?").run(projectId);
    db.db.prepare("DELETE FROM archive_topic_works WHERE project_id=?").run(projectId);
    db.db.prepare("DELETE FROM archive_topics WHERE project_id=?").run(projectId);
    db.db.prepare("DELETE FROM collection_works WHERE collection_id IN (SELECT id FROM collections WHERE project_id=?)").run(projectId);
    db.db.prepare("DELETE FROM collections WHERE project_id=?").run(projectId);
    db.db.prepare(`DELETE FROM candidates WHERE run_id IN (${runs})`).run(projectId);
    db.db.prepare(`DELETE FROM import_items WHERE run_id IN (${runs})`).run(projectId);
    db.db.prepare("DELETE FROM runs WHERE project_id=?").run(projectId);
    db.db.prepare("DELETE FROM seed_profiles WHERE project_id=?").run(projectId);
    db.db.prepare("DELETE FROM changes WHERE project_id=?").run(projectId);
    db.db.prepare("DELETE FROM project_works WHERE project_id=?").run(projectId);
    const chatPrefix = `article-chat:${JSON.stringify([projectId]).slice(0, -1)},`;
    db.db
      .prepare("DELETE FROM preferences WHERE key IN (?,?,?) OR substr(key,1,?)=?")
      .run(`ui:${projectId}`, `classification:${projectId}`, `classification-result:${projectId}`, chatPrefix.length, chatPrefix);
    // Merge snapshots contain complete old tables, this project included.
    db.db.prepare("DELETE FROM merge_history").run();
    // Its last-opened time goes with it.
    db.db.prepare("DELETE FROM projects WHERE id=?").run(projectId);
    const purged = purgeUnreferencedWorks(db, touched, historyReferences(db));
    db.touch();
    return { purged };
  });
}
