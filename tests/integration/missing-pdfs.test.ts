import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../../src/service/service";
import { blankWork } from "../../src/shared/domain";
import { DEFAULT_FILTERS, now, type MissingPdfs, type Run, type Work } from "../../src/shared/types";
import { hashFile } from "../../src/service/interchange/pdf";
import { FulltextEngine } from "../../src/service/fulltext/engine";
import { PdfDownloads } from "../../src/service/fulltext/jobs";
import { schemas } from "../../src/shared/contracts";

const worker = resolve("dist/runtime/pdf-worker.cjs");
const fixturePdf = resolve("tests/fixtures/synthetic-local.pdf");
async function finish(service: Service) {
  const deadline = Date.now() + 15000;
  while ((service.pdf.active.size || service.downloads.active.size) && Date.now() < deadline) await Bun.sleep(10);
  assert.equal(service.pdf.active.size + service.downloads.active.size, 0);
}
async function fixture(fn: (service: Service, root: string, projectId: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "rb-missing-pdfs-"));
  const service = new Service(join(root, "library"), worker, () => {});
  service.oa.lookup = async () => { throw new Error("must not call network"); };
  try { await fn(service, root, service.db.projects()[0].id); }
  finally {
    service.downloads.stopRecoveryMonitor();
    for (const control of [...service.pdf.active.values(), ...service.downloads.active.values()]) control.abort();
    await finish(service);
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
}
function archive(service: Service, projectId: string, title: string, fields: Partial<Work> = {}) {
  const work = service.db.upsert(blankWork({ title, ...fields })).work;
  service.db.mutate(projectId, [work.id], { screening: "included", note: "keep", reading: "reading" });
  return work;
}
function history(service: Service, projectId: string, works: Work[], fields: Partial<Run> = {}) {
  const run: Run = {
    id: randomUUID(), projectId, mode: "search", query: "PDF 원문 확보", seedProfileId: null,
    inputIds: works.map(w => w.id), filters: { ...DEFAULT_FILTERS }, status: "completed", createdAt: now(), updatedAt: now(),
    calls: 0, maxCalls: 0, maxCandidates: works.length, total: works.length, count: 0, message: "실패", tasks: [], rankingVersion: "fulltext-v1",
    download: { includeBooks: false, useBrowser: false, items: works.map(w => ({ workId: w.id, title: w.title, status: "failed", message: "old failure" })) },
    ...fields,
  };
  service.db.saveRun(run);
  return run;
}
async function missing(service: Service, projectId: string, extra = {}): Promise<MissingPdfs> {
  return service.call("missingPdfs", schemas.missingPdfs.parse({ projectId, scope: "archive", ...extra }));
}

test("current queue includes untried archive papers, excludes books by default and ignores other projects and pending intake", () => fixture(async (service, _root, projectId) => {
  const paper = archive(service, projectId, "New paper", { doi: "10.1234/new", url: "https://example.org/new" });
  const book = archive(service, projectId, "Chapter", { type: "book-chapter" });
  archive(service, service.db.createProject("Other", "").id, "Foreign");
  const pending = service.db.upsert(blankWork({ title: "Not yet archived" })).work;
  service.db.mutate(projectId, [pending.id], { screening: "pending" });
  const queue = await missing(service, projectId);
  assert.equal(queue.total, 2);
  assert.equal(queue.books, 1);
  assert.equal(queue.eligible, 1);
  assert.equal(queue.items[0].workId, paper.id);
  assert.equal(queue.items[0].status, "untried");
  assert.equal((await missing(service, projectId, { includeBooks: true })).items.length, 2);
  assert.equal(await service.call("externalUrl", { workId: paper.id, kind: "doi" }), "https://doi.org/10.1234/new");
  assert.equal((await missing(service, projectId)).eligible, 1, "opening a page cannot resolve a paper");
  assert.equal((await missing(service, projectId, { scope: "selected", ids: [book.id] })).books, 1);
}));

test("queue supplies latest per-paper error beyond 100 histories and favors an older resumed active run", () => fixture(async (service, _root, projectId) => {
  const work = archive(service, projectId, "Old unresolved");
  const old = history(service, projectId, [work], { createdAt: "2020-01-01T00:00:00.000Z" });
  for (let i = 0; i < 105; i++) history(service, projectId, [], { createdAt: `2021-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
  assert(!service.db.runs(projectId).some(r => r.id === old.id));
  assert.equal((await missing(service, projectId)).items[0].message, "old failure");
  const newer = history(service, projectId, [work]);
  newer.download!.items[0].message = "latest publisher failure";
  service.db.saveRun(newer);
  assert.equal((await missing(service, projectId)).items[0].message, "latest publisher failure");
  old.download!.items[0].status = "running";
  old.download!.items[0].message = "retrying now";
  service.db.saveRun(old);
  service.downloads.active.set(old.id, new AbortController());
  try { assert.equal((await missing(service, projectId)).items[0].status, "running"); }
  finally { service.downloads.active.delete(old.id); }
}));

test("folder, direct and automatic attachments progressively shrink the current queue while new papers remain", () => fixture(async (service, root, projectId) => {
  const folder = archive(service, projectId, "Packaged PDF extraction fixture");
  const direct = archive(service, projectId, "Directly acquired article");
  const automatic = archive(service, projectId, "Automatically acquired article", { oaUrl: "https://example.org/full.pdf" });
  history(service, projectId, [folder, direct, automatic]);
  const fresh = archive(service, projectId, "New untried article");
  assert.equal((await missing(service, projectId)).eligible, 4);
  await service.call("pdfMatch", { projectId, paths: [fixturePdf] });
  await finish(service);
  let queue = await missing(service, projectId);
  assert.equal(queue.eligible, 3);
  assert(!queue.items.some(item => item.workId === folder.id));
  await service.call("pdfImport", { projectId, paths: [fixturePdf], options: { mode: "managed", workId: direct.id } });
  await finish(service);
  queue = await missing(service, projectId);
  assert.equal(queue.eligible, 2);
  assert(!queue.items.some(item => item.workId === direct.id));
  const pdf = await Bun.file(fixturePdf).arrayBuffer();
  const downloads = new PdfDownloads(service.db, worker, () => {}, new FulltextEngine(async () => new Response(pdf), async () => {}));
  const run = downloads.start({ projectId, scope: "selected", ids: [automatic.id] });
  while (downloads.active.size) await Bun.sleep(10);
  assert.equal(service.db.run(run.id).download!.items[0].status, "completed");
  queue = await missing(service, projectId);
  assert.equal(queue.existing, 3);
  assert.deepEqual(queue.items.map(item => item.workId), [fresh.id]);
  assert.equal(service.db.state(projectId, direct.id).note, "keep");
  assert.equal(service.db.state(projectId, direct.id).reading, "reading");
  assert.equal((await hashFile(service.db.attachments(folder.id)[0].path)), await hashFile(fixturePdf));
  assert(await Bun.file(fixturePdf).exists());
  assert(await Bun.file(join(root, "library", "library.sqlite")).exists());
}));

test("missing or modified files return to the queue even when old results say completed; stale exists flags are not authoritative", () => fixture(async (service, root, projectId) => {
  const work = archive(service, projectId, "Previously completed");
  const run = history(service, projectId, [work]);
  run.download!.items[0].status = "completed";
  service.db.saveRun(run);
  const path = join(root, "linked.pdf");
  await copyFile(fixturePdf, path);
  service.db.saveAttachment({ id: randomUUID(), workId: work.id, name: "linked.pdf", path, mode: "linked", hash: await hashFile(path), size: (await Bun.file(path).size), status: "linked", exists: false });
  assert.equal((await missing(service, projectId)).eligible, 0);
  await writeFile(path, "%PDF-1.4\nmodified file");
  let queue = await missing(service, projectId);
  assert.equal(queue.items[0].status, "missing");
  await rm(path);
  queue = await missing(service, projectId);
  assert.equal(queue.existing, 0);
  assert.equal(queue.items[0].workId, work.id);
  assert.equal(service.db.run(run.id).download!.items[0].status, "completed", "queue reads current files without rewriting old records");
}));

test("current queue respects selection, collection, topic and unclassified boundaries", () => fixture(async (service, _root, projectId) => {
  const assigned = archive(service, projectId, "Assigned");
  const other = archive(service, projectId, "Unclassified");
  const topic = "topic";
  service.db.db.prepare("INSERT INTO archive_topics VALUES(?,?,?,?,?)").run(topic, projectId, "Topic", "", 0);
  service.db.db.prepare("INSERT INTO archive_topic_works VALUES(?,?,?)").run(projectId, assigned.id, topic);
  const collection = service.db.createCollection(projectId, "Collection");
  service.db.db.prepare("INSERT INTO collection_works VALUES(?,?)").run(collection.id, assigned.id);
  for (const extra of [{ scope: "selected", ids: [assigned.id] }, { scope: "topic", scopeId: topic }, { scope: "collection", scopeId: collection.id }])
    assert.deepEqual((await missing(service, projectId, extra)).items.map(item => item.workId), [assigned.id]);
  assert.deepEqual((await missing(service, projectId, { scope: "unclassified" })).items.map(item => item.workId), [other.id]);
  const foreign = archive(service, service.db.createProject("Foreign", "").id, "Foreign work");
  await assert.rejects(missing(service, projectId, { scope: "selected", ids: [foreign.id] }));
  await assert.rejects(missing(service, projectId, { scope: "topic", scopeId: "foreign-topic" }));
}));

test("queue does not truncate large archives at the automatic batch or history display limits", () => fixture(async (service, _root, projectId) => {
  service.db.transaction(() => {
    for (let i = 0; i < 1001; i++) archive(service, projectId, `Unresolved work ${i}`, { doi: `10.1234/queue-${i}` });
  });
  const queue = await missing(service, projectId);
  assert.equal(queue.total, 1001);
  assert.equal(queue.items.length, 1001);
  assert.equal(new Set(queue.items.map(item => item.workId)).size, 1001);
}));
