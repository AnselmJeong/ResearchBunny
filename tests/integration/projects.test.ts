import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../../src/service/service";
import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import { DEFAULT_FILTERS, type Evidence, type Project, type ProjectStats, type Run, type Snapshot } from "../../src/shared/types";
import { schemas } from "../../src/shared/contracts";

async function fixture(fn: (service: Service, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-projects-"));
  const service = new Service(root, "unused", () => {});
  try {
    await fn(service, root);
  } finally {
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
}
// Opening times are ISO strings with millisecond precision.
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
const names = (db: Library) => db.projects().map((p) => p.name);
const evidence = (seedIds: string[]): Evidence => ({
  origins: [], seedIds, sharedIds: [], denominator: 1, relation: "test", score: 0, reasons: [], hidden: [], deferred: false, scope: "test",
});
function run(projectId: string, id: string, inputIds: string[]): Run {
  return {
    id, projectId, mode: "related", query: "", inputIds, seedProfileId: null, filters: DEFAULT_FILTERS,
    status: "completed", createdAt: id, updatedAt: id, calls: 0, maxCalls: 1, maxCandidates: 100, total: null, count: 1,
    message: "", tasks: inputIds.map((seedId) => ({ kind: "cites", seedId, origin: "test" })), rankingVersion: "test",
  };
}

test("projects list most recently opened first, and the app reopens the last one", () => fixture(async (service, root) => {
  const db = service.db;
  const first = db.projects()[0];
  await tick();
  const a = db.createProject("A", "");
  await tick();
  db.createProject("B", "");
  // Never opened: newest first.
  assert.deepEqual(names(db), ["B", "A", "내 연구"]);
  await tick();
  const opened: Snapshot = await service.call("snapshot", { projectId: first.id });
  assert.deepEqual(opened.projects.map((p) => p.name), ["내 연구", "B", "A"]);
  await tick();
  await service.call("snapshot", { projectId: a.id });
  assert.deepEqual(names(db), ["A", "내 연구", "B"]);
  // Polling the open project does not write.
  const at = () => (db.db.prepare("SELECT opened_at FROM project_opens WHERE project_id=?").get(a.id) as { opened_at: string }).opened_at;
  const before = at();
  await tick();
  await service.call("snapshot", { projectId: a.id });
  assert.equal(at(), before);
  // Without a project, the snapshot opens the last one, also after a restart.
  assert.equal((await service.call("snapshot", {}) as Snapshot).projects[0].id, a.id);
  db.close();
  service.db = new Library(root);
  assert.deepEqual(names(service.db), ["A", "내 연구", "B"]);
}));

test("renaming keeps the research question and the list order", () => fixture(async (service) => {
  const db = service.db;
  const project = db.createProject("Old name", "Why?");
  assert.equal(schemas.updateProject.safeParse({ projectId: project.id, name: "   " }).success, false);
  const input = schemas.updateProject.parse({ projectId: project.id, name: "  New name  " });
  const renamed = await service.call("updateProject", input) as Project;
  assert.equal(renamed.name, "New name");
  assert.equal(renamed.question, "Why?");
  assert.deepEqual(names(db), ["New name", "내 연구"]);
  await assert.rejects(service.call("updateProject", { projectId: "missing", name: "X" }), /찾을 수 없습니다/);
}));

test("deleting a project removes what only it holds and keeps shared papers, shelf papers and PDF files", () => fixture(async (service, root) => {
  const db = service.db;
  const other = db.projects()[0].id;
  const p = db.createProject("Doomed", "").id;
  const [only, shared, shelf, candidate, seededElsewhere] = ["Only here", "Shared", "On the shelf", "Candidate only", "Seed elsewhere"]
    .map((title) => db.upsert(blankWork({ title, doi: `10.9999/${title.replace(/ /g, "-")}` })).work);
  db.mutate(p, [only.id, shared.id, shelf.id, seededElsewhere.id], { screening: "included", note: "doomed note" });
  db.mutate(other, [shared.id], { screening: "included", note: "kept note" });
  db.setSeeds(other, [seededElsewhere.id], "", {});
  const collection = db.createCollection(p, "Doomed collection");
  db.db.prepare("INSERT INTO collection_works VALUES(?,?)").run(collection.id, only.id);
  db.setSeeds(p, [only.id], "", { group: [only.id] });
  db.db.prepare("INSERT INTO archive_topics VALUES('topic',?,'Topic','',0)").run(p);
  db.db.prepare("INSERT INTO archive_topic_works VALUES(?,?,'topic')").run(p, only.id);
  const discovery = run(p, "doomed-run", [only.id]);
  db.saveRun(discovery);
  db.candidate(discovery, candidate, evidence([only.id]));
  db.db.prepare("INSERT INTO import_items VALUES('item',?,'a.pdf','completed','ok',?)").run(discovery.id, only.id);
  const kept = run(other, "kept-run", [shared.id]);
  db.saveRun(kept);
  db.candidate(kept, shared, evidence([shared.id]));
  db.db.prepare("INSERT INTO shelf_roots VALUES('r','/shelf','shelf','[]','2026-01-01',NULL)").run();
  db.db.prepare("INSERT INTO shelf_folders VALUES('f:','r','',NULL,'shelf',1)").run();
  db.db.prepare("INSERT INTO shelf_files VALUES('file','r','f:','shelf.pdf',1,1,NULL,NULL,NULL,?,NULL,'resolved','ok','{}','2026-01-01',NULL)").run(shelf.id);
  const pdf = join(root, "managed.pdf");
  await writeFile(pdf, "original bytes");
  db.saveAttachment({ id: "managed", workId: only.id, mode: "managed", path: pdf, name: "managed.pdf", hash: "h", size: 14, exists: true, status: "ready" });
  for (const [project, work] of [[p, only.id], [other, shared.id]]) {
    db.db.prepare("INSERT INTO chat_threads VALUES(?,?,?,'abstract','2026-01-01','{}')").run(`thread-${project}`, project, work);
    db.db.prepare("INSERT INTO chat_heads VALUES(?,?)").run(`head-${project}`, `thread-${project}`);
    db.pref(`article-chat:${JSON.stringify([project, work])}`, {});
    db.pref(`ui:${project}`, {});
  }
  db.pref(`classification:${p}`, { status: "completed" });
  db.pref(`classification-result:${p}`, {});
  db.db.prepare("INSERT INTO merge_history VALUES(1,'{}',0)").run();
  await service.call("snapshot", { projectId: p });

  const stats = await service.call("projectStats", {}) as Record<string, ProjectStats>;
  assert.deepEqual(stats[p], { archive: 4, entries: 5, collections: 1, runs: 1, chats: 1 });
  assert.deepEqual(stats[other], { archive: 1, entries: 1, collections: 0, runs: 1, chats: 1 });

  service.discovery.active.set("job", new AbortController());
  await assert.rejects(service.call("deleteProject", { projectId: p }), /작업이 끝난 뒤/);
  assert.equal(db.projects().length, 2);
  service.discovery.active.clear();

  assert.deepEqual(await service.call("deleteProject", { projectId: p }), { purged: 2 });
  assert.deepEqual(db.projects().map((x) => x.id), [other]);
  for (const [table, column] of [
    ["project_works", "project_id"], ["collections", "project_id"], ["archive_topics", "project_id"], ["archive_topic_works", "project_id"],
    ["seed_profiles", "project_id"], ["runs", "project_id"], ["changes", "project_id"], ["chat_threads", "project_id"], ["project_opens", "project_id"],
  ])
    assert.equal((db.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(p) as { n: number }).n, 0, table);
  for (const table of ["collection_works", "import_items", "merge_history"])
    assert.equal((db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  assert.equal(db.candidates(discovery.id).length, 0);
  assert.deepEqual(db.db.prepare("SELECT scope FROM chat_heads").all(), [{ scope: `head-${other}` }]);
  for (const key of [`ui:${p}`, `classification:${p}`, `classification-result:${p}`, `article-chat:${JSON.stringify([p, only.id])}`])
    assert.equal(db.pref(key), undefined, key);
  assert.deepEqual(db.pref(`ui:${other}`), {});
  assert.deepEqual(db.pref(`article-chat:${JSON.stringify([other, shared.id])}`), {});
  // Papers only this project used leave the library; the PDF file stays.
  assert.throws(() => db.get(only.id));
  assert.throws(() => db.get(candidate.id));
  assert.equal(db.findIdentifier("doi", "10.9999/Only-here"), undefined);
  assert.equal(db.attachments(only.id).length, 0);
  assert.equal(await readFile(pdf, "utf8"), "original bytes");
  // Another project, the shelf and another project's seeds keep theirs.
  assert.equal(db.state(other, shared.id).note, "kept note");
  assert.equal(db.candidates(kept.id).length, 1);
  assert.equal(db.get(shelf.id).id, shelf.id);
  assert.equal(db.get(seededElsewhere.id).id, seededElsewhere.id);
  assert.equal((db.db.pragma("foreign_key_check") as unknown[]).length, 0);
  assert.equal((await service.call("snapshot", {}) as Snapshot).projects[0].id, other);

  await assert.rejects(service.call("deleteProject", { projectId: other }), /하나뿐/);
  await assert.rejects(service.call("deleteProject", { projectId: p }), /찾을 수 없습니다/);
  assert.deepEqual(db.projects().map((x) => x.id), [other]);
}));
