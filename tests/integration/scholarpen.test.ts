import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import { ScreeningStore } from "../../src/service/screening/store";
import { EvidenceTables } from "../../src/service/evidence";
import { ScholarPenLinks } from "../../src/service/scholarpen";
import { deleteProject } from "../../src/service/db/projects";
import type { LinkedArchiveFile, LinkedProjectFile } from "../../src/shared/scholarpen";

const BIB = `@article{Smith2019,
  title = {Clozapine augmentation with aripiprazole},
  author = {Smith, Anna and Park, Jun},
  year = {2019},
  journal = {Schizophrenia Research},
  doi = {10.1016/j.schres.2019.01.001}
}
@article{Lee2021,
  title = {Electroconvulsive therapy in clozapine-resistant schizophrenia},
  author = {Lee, Min},
  year = {2021},
  journal = {Brain Stimulation},
  doi = {10.1016/j.brs.2021.02.002}
}
`;

async function fixture(fn: (ctx: { db: Library; links: ScholarPenLinks; root: string; shared: string; evidence: EvidenceTables }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-scholarpen-"));
  const shared = join(root, "_ScholarPen_");
  await mkdir(join(shared, "TRS review", "exports"), { recursive: true });
  await writeFile(join(shared, "TRS review", "exports", "references.bib"), BIB);
  await mkdir(join(shared, "Methods paper"));
  await mkdir(join(shared, ".trash"));
  await writeFile(join(shared, "AGENTS.md"), "vault notes");
  const db = new Library(join(root, "library"));
  const screening = new ScreeningStore(db.db, () => "");
  const evidence = new EvidenceTables({ db, ai: { json: async () => { throw new Error("unused"); } }, route: () => null, purpose: () => "original", search: async () => [], emit: () => {} });
  const links = new ScholarPenLinks({ db, screening, evidence, indexed: () => new Set(), emit: () => {} });
  try {
    await fn({ db, links, root, shared, evidence });
  } finally {
    links.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}
const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;

test("every folder ScholarPen shows is a link candidate; dot-folders and files are not", async () => fixture(async ({ links, shared }) => {
  assert.equal((await links.state()).root, null);
  const state = await links.configure(shared);
  assert.equal(state.online, true);
  assert.deepEqual(state.folders.map((f) => [f.name, f.hasReferences]), [["Methods paper", false], ["TRS review", true]]);
  await assert.rejects(async () => links.configure(join(shared, "missing")), /공유 폴더를 찾을 수 없습니다/);
}));

test("a linked folder gets project.json and archive.json, written again only when they change", async () => fixture(async ({ db, links, shared, evidence }) => {
  await links.configure(shared);
  const projectId = db.projects()[0].id;
  db.updateProject(projectId, "TRS", "클로자핀 증강의 효과");
  const { work } = db.upsert(blankWork({ title: "Aripiprazole augmentation", doi: "10.1234/a", year: 2019, authors: ["Smith, A"], venue: "Schizophr Res" }));
  db.mutate(projectId, [work.id], { screening: "included" });
  const collection = db.createCollection(projectId, "증강 요법");
  db.db.prepare("INSERT INTO collection_works VALUES(?,?)").run(collection.id, work.id);
  new ScreeningStore(db.db).saveCharacter(work.id, { type: "O", contributions: ["primary"], source: "ai", reason: "", judgedAt: "" });
  new ScreeningStore(db.db).saveProfile(projectId, { purpose: "original", include: [{ id: "a", text: "사람 대상" }] });
  const state = await links.link(projectId, "Methods paper");
  assert.equal(state.links[projectId], "Methods paper");
  const dir = join(shared, "Methods paper", ".researchbunny");
  const project = await readJson<LinkedProjectFile>(join(dir, "project.json"));
  assert.equal(project.projectId, projectId);
  assert.equal(project.question, "클로자핀 증강의 효과");
  assert.deepEqual(project.screening.include, ["사람 대상"]);
  const archive = await readJson<LinkedArchiveFile>(join(dir, "archive.json"));
  assert.deepEqual(archive.works.map((w) => [w.doi, w.type, w.collections, w.pdf, w.indexed]), [["10.1234/a", "O", ["증강 요법"], false, false]]);
  assert(!existsSync(join(dir, "evidence.csv")));
  // Nothing changed: nothing is written, so Drive has nothing to sync.
  const before = (await stat(join(dir, "archive.json"))).mtimeMs;
  assert.deepEqual((await links.sync(projectId)).written, []);
  assert.equal((await stat(join(dir, "archive.json"))).mtimeMs, before);
  // The library changes: the next tick writes the archive again.
  const second = db.upsert(blankWork({ title: "ECT and clozapine", doi: "10.1234/b" })).work;
  db.mutate(projectId, [second.id], { screening: "included" });
  await links.tick();
  assert.equal((await readJson<LinkedArchiveFile>(join(dir, "archive.json"))).works.length, 2);
  // With evidence rows, the table is written too.
  evidence.store.saveRow(projectId, { workId: work.id, cells: { design: { value: "무작위", quote: "randomised", page: 3, pageEnd: 3, section: "", passageId: 1, attachmentId: null, status: "ok" } }, basis: "fulltext", columnsVersion: 1, model: "x", filledAt: "" });
  await links.sync(projectId);
  assert.match(await readFile(join(dir, "evidence.md"), "utf8"), /무작위 \(p\. 3\)/);
  assert.match(await readFile(join(dir, "evidence.csv"), "utf8"), /^work_id,citekey/);
  // One folder, one project.
  const other = db.createProject("Other", "");
  await assert.rejects(links.link(other.id, "Methods paper"), /이미 ‘TRS’ 프로젝트에 연결/);
  await assert.rejects(links.link(other.id, "../escape"), /폴더 이름을 확인하세요/);
  // A new folder named after the project.
  await links.link(other.id, "Other", true);
  assert(existsSync(join(shared, "Other", ".researchbunny", "project.json")));
  // Unlinking keeps the files; deleting the project drops the link.
  await links.link(projectId, null);
  assert(existsSync(join(dir, "project.json")));
  deleteProject(db, other.id);
  assert.deepEqual(Object.keys((await links.state()).links), []);
}));

test("a project made from a folder takes its name, its references and the link", async () => fixture(async ({ db, links, shared }) => {
  await links.configure(shared);
  const result = await links.createFromFolder("TRS review");
  assert.equal(result.project.name, "TRS review");
  assert.equal(result.imported, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.withoutPdf.length, 2);
  assert.equal(db.counts(result.project.id).archive, 2);
  const state = await links.state();
  assert.equal(state.folders.find((f) => f.name === "TRS review")!.projectId, result.project.id);
  // ResearchBunny never writes ScholarPen's own files.
  assert.equal(await readFile(join(shared, "TRS review", "exports", "references.bib"), "utf8"), BIB);
  const archive = await readJson<LinkedArchiveFile>(join(shared, "TRS review", ".researchbunny", "archive.json"));
  assert.deepEqual(archive.works.map((w) => w.doi).sort(), ["10.1016/j.brs.2021.02.002", "10.1016/j.schres.2019.01.001"]);
  await assert.rejects(links.createFromFolder("TRS review"), /이미 프로젝트에 연결/);
}));
