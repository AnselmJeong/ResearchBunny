import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import { AppError } from "../../src/shared/types";
import { FulltextEngine, cleanDoi, htmlPdfUrls, publisherPdfUrls, publicUrl, unpaywallUrls, type DownloadFetch } from "../../src/service/fulltext/engine";
import { PdfDownloads } from "../../src/service/fulltext/jobs";
import { createBackup, restoreBackup } from "../../src/service/interchange/backup";
import { hashFile } from "../../src/service/interchange/pdf";
import { deleteTrashedWorks } from "../../src/service/db/trash";
import { schemas } from "../../src/shared/contracts";
import { mergeWorks, undoMerge } from "../../src/service/db/merge";
import { Service } from "../../src/service/service";

const pdf = await readFile(resolve("tests/fixtures/synthetic-local.pdf"));
const worker = resolve("dist/runtime/pdf-worker.cjs");
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const engine = (fetcher: DownloadFetch) => new FulltextEngine(fetcher, async () => {});
async function fixture(fn: (db: Library, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-fulltext-"));
  const db = new Library(join(root, "library"));
  try { await fn(db, root); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
function add(db: Library, projectId: string, suffix: string, fields = {}) {
  const { work } = db.upsert(blankWork({ title: `Fulltext preservation ${suffix}`, doi: `10.1234/fulltext-${suffix}`, oaUrl: `https://papers.example.org/${suffix}.pdf`, year: 1995, ...fields }));
  db.mutate(projectId, [work.id], { screening: "included", note: "keep note", reading: "reading", tags: ["keep tag"] });
  return work;
}
async function finish(downloads: PdfDownloads) {
  for (let i = 0; i < 2000 && downloads.active.size; i++) await Bun.sleep(5);
  assert.equal(downloads.active.size, 0, "download must reach a terminal state");
}

test("ported candidate rules preserve DOI escapes, OA priority, HTML entities and reject private/credential URLs", () => {
  assert.equal(cleanDoi("https://doi.org/10.1234/a\\_b"), "10.1234/a_b");
  assert.deepEqual(unpaywallUrls({ best_oa_location: { url_for_pdf: "https://example.org/best.pdf" }, oa_locations: [{ url_for_pdf: "https://example.org/best.pdf" }, { url_for_pdf: "https://example.org/other.pdf" }] }), ["https://example.org/best.pdf", "https://example.org/other.pdf"]);
  assert.deepEqual(htmlPdfUrls('<meta content="/article.pdf?a=1&amp;b=2" name="citation_pdf_url"><a href="javascript:alert(1)">PDF</a>', "https://example.org/paper"), ["https://example.org/article.pdf?a=1&b=2"]);
  assert.deepEqual(publisherPdfUrls("https://onlinelibrary.wiley.com/doi/abs/10.1234/test"), ["https://onlinelibrary.wiley.com/doi/pdfdirect/10.1234/test?download=true"]);
  assert.deepEqual(publisherPdfUrls("https://journals.plos.org/plosone/article?id=10.1234/test"), ["https://journals.plos.org/plosone/article/file?id=10.1234/test&type=printable"]);
  for (const url of ["file:///etc/passwd", "http://localhost/test.pdf", "http://127.0.0.1/pdf", "http://2130706433/pdf", "http://192.168.1.1/pdf", "http://169.254.169.254/pdf", "http://[::1]/pdf", "https://user:pass@example.org/pdf"]) assert.equal(publicUrl(url), null, url);
  assert.throws(() => schemas.downloadPdfs.parse({ projectId: "p", scope: "run" }));
});

test("landing HTML with a lying PDF content type is followed to a real PDF, and split header chunks work", () => fixture(async (_db, root) => {
  const requests: string[] = [];
  const e = engine(async url => {
    requests.push(url);
    if (url.endsWith("/landing")) return new Response('<meta name="citation_pdf_url" content="/real.pdf">', { headers: { "content-type": "application/pdf" } });
    return new Response(new ReadableStream({ start(c) { c.enqueue(pdf.subarray(0, 2)); c.enqueue(pdf.subarray(2)); c.close(); } }));
  });
  const path = join(root, "result.part");
  const result = await e.retrieve(blankWork({ oaUrl: "https://example.org/landing" }), path, new AbortController().signal, () => {});
  assert.equal(result.sourceUrl, "https://example.org/real.pdf");
  assert.deepEqual(await readFile(path), pdf);
  assert.equal(requests.length, 2);
}));

test("Unpaywall outages do not prevent provider downloads, corrupt candidates fall through, and private redirects stop", () => fixture(async (_db, root) => {
  const path = join(root, "pdf.part");
  const e = engine(async url => {
    if (url.endsWith("bad.pdf")) return new Response("%PDF-1.4\ncorrupt");
    if (url.endsWith("good.pdf")) return new Response(pdf);
    throw new Error("API must not be needed for provider PDF");
  });
  const seen: string[] = [];
  const result = await e.retrieve(blankWork({ doi: "10.1234/known", oaUrl: "https://example.org/bad.pdf", raw: { locations: [{ pdf_url: "https://example.org/good.pdf" }] } }), path,
    new AbortController().signal, () => {}, async candidate => {
      seen.push(candidate.sourceUrl);
      if (candidate.sourceUrl.endsWith("bad.pdf")) throw new AppError("INVALID_PDF", "corrupt");
    });
  assert.equal(result.sourceUrl, "https://example.org/good.pdf");
  assert.equal(seen.length, 2);
  const visited: string[] = [];
  await assert.rejects(engine(async url => { visited.push(url); return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }); })
    .retrieve(blankWork({ oaUrl: "https://example.org/redirect" }), path, new AbortController().signal, () => {}));
  assert.equal(visited[0], "https://example.org/redirect");
  assert(visited.every(url => publicUrl(url)), "redirect must never fetch a private address");
}));

test("Crossref lookup rejects a wrong author/year and uses a confident DOI only", async () => {
  const w = blankWork({ title: "A specific intervention for depression", year: 2024, authors: ["Smith, Jane"] });
  const match = { DOI: "10.1234/correct", title: [w.title], author: [{ family: "Smith" }], issued: { "date-parts": [[2024]] } };
  const e = engine(async () => json({ message: { items: [{ ...match, DOI: "10.1234/wrong", author: [{ family: "Jones" }] }, match] } }));
  assert.equal(await e.lookupDoi(w, new AbortController().signal), "10.1234/correct");
  assert.equal(await engine(async () => json({ message: { items: [{ ...match, issued: { "date-parts": [[2010]] } }] } })).lookupDoi(w, new AbortController().signal), null);
});

test("hash attachments preserve classification, notes, pre-2010 papers, shared projects and backup/restore", () => fixture(async (db, root) => {
  const projectId = db.projects()[0].id;
  const w = add(db, projectId, "one");
  const other = db.createProject("Shared project", "");
  db.mutate(other.id, [w.id], { screening: "included" });
  db.db.prepare("INSERT INTO archive_topics VALUES(?,?,?,?,?)").run("topic", projectId, "TMS", "Preserve", 0);
  db.db.prepare("INSERT INTO archive_topic_works VALUES(?,?,?)").run(projectId, w.id, "topic");
  const before = db.view(projectId, w.id);
  let requests = 0;
  const downloads = new PdfDownloads(db, worker, () => {}, engine(async () => { requests++; return new Response(pdf); }));
  assert.deepEqual(await downloads.preview({ projectId, scope: "topic", scopeId: "topic" }), { total: 1, existing: 0, books: 0, eligible: 1 });
  const run = downloads.start({ projectId, scope: "topic", scopeId: "topic" }); await finish(downloads);
  assert.equal(db.run(run.id).download!.items[0].status, "completed");
  const attached = db.attachments(w.id)[0];
  assert.equal(attached.path, join(db.root, "attachments", await hashFile(attached.path) + ".pdf"));
  assert.equal(attached.sourceUrl, w.oaUrl);
  assert.deepEqual(db.view(projectId, w.id).state, before.state);
  assert.equal(db.view(projectId, w.id).archiveTopicId, before.archiveTopicId);
  const second = downloads.start({ projectId: other.id, scope: "archive" }); await finish(downloads);
  assert.equal(db.run(second.id).download!.items[0].status, "existing");
  assert.equal(requests, 1);
  const backup = await createBackup(db, join(root, "backup"), true, false);
  const restored = await restoreBackup(backup.path, join(root, "restored"));
  const check = new Library(restored.path);
  try { assert.equal(check.view(projectId, w.id).archiveTopicId, "topic"); assert.equal(await hashFile(check.attachments(w.id)[0].path), attached.hash); } finally { check.close(); }
}));

test("failed/HTML/corrupt items do not stop later papers, books skip, retry preserves successes and repairs missing attachments", () => fixture(async (db, _root) => {
  const projectId = db.projects()[0].id;
  const bad = add(db, projectId, "bad");
  const good = add(db, projectId, "good");
  const book = add(db, projectId, "book", { type: "book-chapter" });
  let recovered = false;
  const visits: string[] = [];
  const downloads = new PdfDownloads(db, worker, () => {}, engine(async url => {
    visits.push(url);
    if (url.includes("api.unpaywall")) return json({});
    if (url === good.oaUrl || (recovered && url === bad.oaUrl)) return new Response(pdf);
    return new Response("%PDF-1.4\ncorrupt");
  }));
  const run = downloads.start({ projectId, scope: "archive" }); await finish(downloads);
  let items = db.run(run.id).download!.items;
  assert.equal(items.find(i => i.workId === bad.id)!.status, "failed");
  assert.equal(items.find(i => i.workId === good.id)!.status, "completed");
  assert.equal(items.find(i => i.workId === book.id)!.status, "skipped");
  assert.equal(db.attachments(bad.id).length, 0);
  assert(!(await readdir(join(db.root, "downloads"))).length);
  recovered = true;
  const goodVisits = visits.filter(u => u === good.oaUrl).length;
  downloads.control(run.id, "resume"); await finish(downloads);
  items = db.run(run.id).download!.items;
  assert.equal(items.find(i => i.workId === bad.id)!.status, "completed");
  assert.equal(visits.filter(u => u === good.oaUrl).length, goodVisits);
  assert.equal((await readdir(join(db.root, "attachments"))).length, 1);
  const attached = db.attachments(bad.id)[0];
  await rm(attached.path);
  downloads.start({ projectId, scope: "selected", ids: [bad.id] }); await finish(downloads);
  assert.equal(db.attachments(bad.id).length, 1);
  assert.equal((await stat(db.attachments(bad.id)[0].path)).size, pdf.length);
}));

test("cancellation removes partial downloads; persisted interrupted runs resume without resurrecting deleted targets", () => fixture(async (db, _root) => {
  const projectId = db.projects()[0].id;
  const w = add(db, projectId, "cancel");
  let blocked = true;
  let fetching = false;
  const downloads = new PdfDownloads(db, worker, () => {}, engine(async (_url, init) => {
    fetching = true;
    if (!blocked) return new Response(pdf);
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(pdf.subarray(0, 5));
      init!.signal!.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
    } }));
  }));
  const run = downloads.start({ projectId, scope: "archive" });
  for (let i = 0; i < 100 && !fetching; i++) await Bun.sleep(5);
  downloads.control(run.id, "cancel"); await finish(downloads);
  assert.equal(db.run(run.id).status, "cancelled");
  assert.equal(db.run(run.id).download!.items[0].status, "pending");
  assert.equal(db.attachments(w.id).length, 0);
  assert.deepEqual(await readdir(join(db.root, "downloads")), []);
  blocked = false;
  const saved = db.run(run.id); saved.status = "interrupted"; saved.download!.items[0].status = "running"; db.saveRun(saved);
  downloads.control(run.id, "resume"); await finish(downloads);
  assert.equal(db.run(run.id).download!.items[0].status, "completed");
  db.mutate(projectId, [w.id], { screening: "trash" });
  deleteTrashedWorks(db, projectId, [w.id]);
  downloads.control(run.id, "resume"); await finish(downloads);
  assert.equal(db.run(run.id).download!.items[0].status, "skipped");
  assert.throws(() => db.get(w.id));
}));

test("preview rejects foreign project targets and counts book exclusions; content length limits prevent oversized attachment", () => fixture(async (db, root) => {
  const projectId = db.projects()[0].id;
  add(db, projectId, "book", { type: "book-chapter" });
  const other = db.createProject("Other", "");
  const foreign = add(db, other.id, "foreign");
  const downloads = new PdfDownloads(db, worker, () => {}, engine(async () => new Response(pdf)));
  await assert.rejects(downloads.preview({ projectId, scope: "selected", ids: [foreign.id] }));
  assert.deepEqual(await downloads.preview({ projectId, scope: "archive" }), { total: 1, existing: 0, books: 1, eligible: 0 });
  assert.equal((await downloads.preview({ projectId, scope: "archive", includeBooks: true })).eligible, 1);
  const path = join(root, "big.part");
  await assert.rejects(engine(async url => url.includes("api.crossref") ? json({}) : new Response(pdf, { headers: { "content-length": "999999999" } }))
    .retrieve(blankWork({ oaUrl: "https://example.org/big.pdf", doi: null }), path, new AbortController().signal, () => {}));
  await assert.rejects(stat(path));
}));

test("merge maps interrupted download targets to the surviving paper and undo restores the job", () => fixture(async (db, _root) => {
  const projectId = db.projects()[0].id;
  const keep = add(db, projectId, "keep"), remove = add(db, projectId, "remove");
  const downloads = new PdfDownloads(db, worker, () => {}, engine(async () => new Response(pdf)));
  const run = downloads.start({ projectId, scope: "archive" }); await finish(downloads);
  const saved = db.run(run.id);
  saved.status = "interrupted";
  for (const item of saved.download!.items) item.status = "pending";
  db.saveRun(saved);
  mergeWorks(db, keep.id, remove.id);
  assert.deepEqual(db.run(run.id).download!.items.map(i => i.workId), [keep.id]);
  assert.equal(db.run(run.id).total, 1);
  assert.equal(undoMerge(db), true);
  assert.equal(db.run(run.id).download!.items.length, 2);
  mergeWorks(db, keep.id, remove.id);
  downloads.control(run.id, "resume"); await finish(downloads);
  assert.equal(db.run(run.id).download!.items[0].status, "existing");
}));

test("service routes validated commands, blocks concurrent destructive jobs and cancels downloads during shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-download-service-"));
  const service = new Service(join(root, "library"), worker, () => {});
  const projectId = service.db.projects()[0].id;
  add(service.db, projectId, "service");
  service.downloads = new PdfDownloads(service.db, worker, () => {}, engine(async (_url, init) => {
    await new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    return new Response(pdf);
  }));
  try {
    assert.equal((await service.call("pdfDownloadPreview", schemas.pdfDownloadPreview.parse({ projectId, scope: "archive" }))).eligible, 1);
    const run = await service.call("downloadPdfs", schemas.downloadPdfs.parse({ projectId, scope: "archive" }));
    assert.equal(service.busy(), true);
    for (const command of ["downloadPdfs", "backup", "deleteTrashedWorks", "startRun", "classifyArchive", "merge"])
      await assert.rejects(service.call(command, { projectId, scope: "archive" }), (error: unknown) => error instanceof AppError && error.code === "BUSY");
    await service.call("shutdown", {}); await finish(service.downloads);
    assert.equal(service.db.run(run.id).status, "cancelled");
    assert.equal(service.busy(), false);
  } finally { service.db.close(); await rm(root, { recursive: true, force: true }); }
});
