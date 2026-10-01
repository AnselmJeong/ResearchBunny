import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../../src/service/service";
import { blankWork } from "../../src/shared/domain";
import { DEFAULT_FILTERS, now, type Run, type Snapshot, type Work } from "../../src/shared/types";
import { hashFile } from "../../src/service/interchange/pdf";
import { schemas, type Outputs } from "../../src/shared/contracts";

const worker = resolve("dist/runtime/pdf-worker.cjs");
const fixturePdf = resolve("tests/fixtures/synthetic-local.pdf");
const title = "Packaged PDF extraction fixture";
async function finish(service: Service) {
  const deadline = Date.now() + 15000;
  while (service.pdf.active.size && Date.now() < deadline) await Bun.sleep(10);
  assert.equal(service.pdf.active.size, 0, "PDF job must finish");
}
async function fixture(fn: (service: Service, root: string, projectId: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "rb-pdf-match-"));
  const service = new Service(join(root, "library"), worker, () => {});
  service.oa.lookup = async () => { throw new Error("folder matching must not use network lookup"); };
  try { await fn(service, root, service.db.projects()[0].id); }
  finally {
    service.downloads.stopRecoveryMonitor();
    for (const control of service.pdf.active.values()) control.abort();
    await finish(service);
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
}
function archive(service: Service, projectId: string, fields: Partial<Work> = {}) {
  const work = service.db.upsert(blankWork({ title, ...fields })).work;
  service.db.mutate(projectId, [work.id], { screening: "included", note: "keep", reading: "reading", tags: ["keep"] });
  return work;
}
function history(service: Service, projectId: string, work: Work, fields: Partial<Run> = {}) {
  const run: Run = {
    id: randomUUID(), projectId, mode: "search", query: "PDF 원문 확보 (1편)", seedProfileId: null,
    inputIds: [work.id], filters: { ...DEFAULT_FILTERS }, status: "completed", createdAt: now(), updatedAt: now(),
    calls: 0, maxCalls: 0, maxCandidates: 1, total: 1, count: 0, message: "실패 1편", tasks: [], rankingVersion: "fulltext-v1",
    download: { includeBooks: false, useBrowser: false, items: [{ workId: work.id, title: work.title, status: "failed", message: "not found", errorCode: "NO_PDF" }] },
    ...fields,
  };
  service.db.saveRun(run);
  return run;
}

test("folder matching links only missing archive PDFs, keeps originals and classifications, and reports every file", async () => {
  await fixture(async (service, root, projectId) => {
    const work = archive(service, projectId);
    const otherProject = service.db.createProject("Other", "");
    const foreign = archive(service, otherProject.id, { title: "Foreign article", doi: "10.1234/foreign" });
    const collection = service.db.createCollection(projectId, "Preserve collection");
    service.db.db.prepare("INSERT INTO collection_works VALUES(?,?)").run(collection.id, work.id);
    service.db.db.prepare("INSERT INTO archive_topics VALUES(?,?,?,?,?)").run("retain-topic", projectId, "Preserve topic", "", 0);
    service.db.db.prepare("INSERT INTO archive_topic_works VALUES(?,?,?)").run(projectId, work.id, "retain-topic");
    const before = { work: service.db.get(work.id), state: service.db.state(projectId, work.id) };
    const past = history(service, projectId, work);
    const folder = join(root, "downloads"), nested = join(folder, "subfolder");
    await mkdir(nested, { recursive: true });
    await writeFile(join(folder, "00-invalid.pdf"), "HTML response");
    await copyFile(fixturePdf, join(nested, "publisher.PDF"));
    await copyFile(fixturePdf, join(nested, "duplicate.pdf"));
    await symlink(nested, join(folder, "recursive-symlink"));
    await writeFile(join(folder, "ignore.txt"), "ignore");
    const original = await readFile(join(nested, "publisher.PDF"));
    const run: Run = await service.call("pdfMatch", { projectId, paths: [folder] });
    await finish(service);
    const snapshot: Snapshot = await service.call("snapshot", { projectId });
    const final = snapshot.runs.find(r => r.id === run.id)!;
    assert.equal(final.status, "completed");
    assert.equal(final.count, 1);
    assert.equal(final.calls, 0);
    assert.equal(final.import!.index, 3);
    const items: Outputs["importItems"] = await service.call("importItems", { runId: run.id });
    assert.equal(items.length, 3);
    assert.equal(items.filter(i => i.status === "failed").length, 1);
    assert.equal(items.filter(i => i.status === "skipped").length, 1);
    assert.equal(service.db.attachments(work.id).length, 1);
    const attachment = service.db.attachments(work.id)[0];
    assert.equal(attachment.mode, "managed");
    assert.equal(await hashFile(attachment.path), await hashFile(join(nested, "publisher.PDF")));
    assert.deepEqual(await readFile(join(nested, "publisher.PDF")), original);
    assert.deepEqual({ work: service.db.get(work.id), state: service.db.state(projectId, work.id) }, before);
    assert.equal(service.db.attachments(foreign.id).length, 0);
    assert.equal((service.db.db.prepare("SELECT count(*) AS n FROM works").get() as { n: number }).n, 2);
    assert(service.db.db.prepare("SELECT 1 FROM collection_works WHERE collection_id=? AND work_id=?").get(collection.id, work.id));
    assert(service.db.db.prepare("SELECT 1 FROM archive_topic_works WHERE project_id=? AND work_id=? AND topic_id=?").get(projectId, work.id, "retain-topic"));
    assert.equal((service.db.db.prepare("SELECT count(*) AS n FROM candidates WHERE run_id=?").get(run.id) as { n: number }).n, 0);
    assert.equal(service.db.run(past.id).download!.items[0].status, "completed");
    const again: Run = await service.call("pdfMatch", { projectId, paths: [nested] });
    await finish(service);
    assert.equal(service.db.run(again.id).count, 0);
    assert.equal(service.db.attachments(work.id).length, 1);
  });
});

test("ambiguous matches stay unlinked even when another matching work already has a PDF", async () => {
  await fixture(async (service, root, projectId) => {
    const a = archive(service, projectId, { doi: "10.1234/a" });
    const b = archive(service, projectId, { doi: "10.1234/b" });
    service.db.saveAttachment({ id: randomUUID(), workId: a.id, name: "existing.pdf", path: fixturePdf, hash: await hashFile(fixturePdf), size: (await readFile(fixturePdf)).length, mode: "linked", status: "existing", exists: true });
    const run: Run = await service.call("pdfMatch", { projectId, paths: [fixturePdf] });
    await finish(service);
    assert.equal(service.db.run(run.id).count, 0);
    assert.equal(service.db.attachments(b.id).length, 0);
    const items: Outputs["importItems"] = await service.call("importItems", { runId: run.id });
    assert.equal(items[0].status, "skipped");
    assert(items[0].message.includes("여러 항목"));
    assert.equal((service.db.db.prepare("SELECT count(*) AS n FROM works").get() as { n: number }).n, 2);
    assert.equal((await readFile(fixturePdf)).subarray(0, 5).toString(), "%PDF-");
  });
});

test("unmatched, nonarchive and damaged files are reported without creating or resurrecting entries", async () => {
  await fixture(async (service, root, projectId) => {
    const work = archive(service, projectId);
    service.db.mutate(projectId, [work.id], { screening: "trash" });
    const damaged = join(root, "damaged.pdf");
    await writeFile(damaged, "%PDF-1.4\nnot a document");
    const run: Run = await service.call("pdfMatch", { projectId, paths: [fixturePdf, damaged] });
    await finish(service);
    const items: Outputs["importItems"] = await service.call("importItems", { runId: run.id });
    assert.equal(items.length, 2);
    assert(items.every(i => i.status === "skipped"));
    assert(items.some(i => i.message.includes("추출 불가")));
    assert(items.some(i => i.message.includes("일치하는 아카이브 항목 없음")));
    assert.equal(service.db.attachments(work.id).length, 0);
    assert.equal(service.db.state(projectId, work.id).screening, "trash");
    assert.equal((service.db.db.prepare("SELECT count(*) AS n FROM works").get() as { n: number }).n, 1);
  });
});

test("folder matching repairs missing same-hash attachments and corrupted managed copies without duplicate records", async () => {
  await fixture(async (service, root, projectId) => {
    const work = archive(service, projectId);
    const hash = await hashFile(fixturePdf), id = randomUUID();
    const target = join(service.db.root, "attachments", hash + ".pdf");
    await mkdir(join(service.db.root, "attachments"), { recursive: true });
    await writeFile(target, "%PDF-1.4 corrupted");
    service.db.saveAttachment({ id, workId: work.id, name: "old.pdf", path: join(root, "missing.pdf"), hash, mode: "linked", size: 0, status: "missing", exists: false });
    const past = history(service, projectId, work);
    await service.downloads.syncHistory();
    assert.equal(service.db.run(past.id).download!.items[0].status, "failed");
    const run: Run = await service.call("pdfMatch", { projectId, paths: [fixturePdf] });
    await finish(service);
    await service.call("snapshot", { projectId });
    assert.equal(service.db.run(run.id).count, 1);
    const attachments = service.db.attachments(work.id);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].id, id);
    assert.equal(attachments[0].path, target);
    assert.equal(await hashFile(target), hash);
    assert.equal(service.db.run(past.id).download!.items[0].status, "completed");
  });
});

test("direct PDF attachment updates all past failures, including old and shared-project runs, and survives restart", async () => {
  await fixture(async (service, root, projectId) => {
    const work = archive(service, projectId);
    const other = service.db.createProject("Shared", "");
    service.db.mutate(other.id, [work.id], { screening: "included" });
    const runs = Array.from({ length: 105 }, (_, index) => history(service, index % 2 ? other.id : projectId, work, { createdAt: new Date(index * 1000).toISOString() }));
    assert.equal(service.db.runs().length, 100);
    await service.downloads.syncHistory();
    assert(runs.every(run => service.db.run(run.id).download!.items[0].status === "failed"));
    const active = runs[0];
    service.downloads.active.set(active.id, new AbortController());
    const imported = await service.pdf.start(projectId, [fixturePdf], { mode: "managed", workId: work.id });
    await finish(service);
    assert.equal(service.db.run(imported.id).count, 1);
    await service.call("snapshot", { projectId });
    assert.equal(service.db.run(active.id).download!.items[0].status, "failed", "active run must not be overwritten by history reconciliation");
    service.downloads.active.delete(active.id);
    await service.downloads.syncHistory();
    assert(runs.every(run => {
      const updated = service.db.run(run.id);
      return updated.download!.items[0].status === "completed" && !updated.download!.items[0].errorCode && updated.count === 1 && updated.message.includes("실패 0편");
    }));
    const reopened = new Service(join(root, "library"), worker, () => {});
    try {
      await reopened.downloads.syncHistory();
      assert.equal(reopened.db.run(runs[0].id).download!.items[0].status, "completed");
      assert.equal(reopened.db.attachments(work.id).length, 1);
    } finally { reopened.db.close(); }
  });
});

test("folder jobs can resume after cancellation and retry only failed files with identical basenames", async () => {
  await fixture(async (service, root, projectId) => {
    const work = archive(service, projectId);
    const a = join(root, "a"), b = join(root, "b");
    await mkdir(a); await mkdir(b);
    await copyFile(fixturePdf, join(a, "article.pdf"));
    await writeFile(join(b, "article.pdf"), "broken");
    const run = await service.pdf.start(projectId, [a, b], { mode: "managed", matchExistingOnly: true });
    service.pdf.control(run.id, "cancel");
    await finish(service);
    assert.equal(service.db.run(run.id).status, "cancelled");
    service.pdf.control(run.id, "resume");
    await finish(service);
    assert.equal(service.db.run(run.id).count, 1);
    await copyFile(fixturePdf, join(b, "article.pdf"));
    service.pdf.control(run.id, "resume");
    await finish(service);
    const final = service.db.run(run.id);
    assert.deepEqual(final.import!.paths, [join(b, "article.pdf")]);
    assert.equal(final.count, 1);
    assert.equal(service.db.attachments(work.id).length, 1);
    assert.equal((await service.call("importItems", { runId: run.id }) as Outputs["importItems"]).filter(i => i.status === "failed").length, 0);
    assert.deepEqual(schemas.choosePdfMatch.parse({ projectId }), { projectId });
  });
});
