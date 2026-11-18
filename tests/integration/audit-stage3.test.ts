import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChatStore } from "../../src/service/chat/store";
import { Library } from "../../src/service/db/database";
import { mergeWorks, undoMerge } from "../../src/service/db/merge";
import { citationPdfUrls, FulltextEngine, type RetrievedPdf } from "../../src/service/fulltext/engine";
import { PdfDownloads } from "../../src/service/fulltext/jobs";
import { createBackup, restoreBackup } from "../../src/service/interchange/backup";
import { hashFile } from "../../src/service/interchange/pdf";
import { ABSTRACT_CONTEXT } from "../../src/shared/chat";
import { blankWork } from "../../src/shared/domain";
import { AppError, DEFAULT_FILTERS, now, type Attachment, type Run } from "../../src/shared/types";

const fixturePdf = resolve("tests/fixtures/synthetic-local.pdf");
const worker = resolve("dist/runtime/pdf-worker.cjs");
async function fixture<T>(fn: (db: Library, root: string) => Promise<T> | T) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-stage3-"));
  const db = new Library(join(root, "library"));
  try {
    return await fn(db, root);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}
const provider = (db: Library) =>
  db.upsert(blankWork({
    source: "openalex", openalex: "W77", doi: "10.7777/full", pmid: "777", title: "Interoceptive inference in the anterior insula",
    authors: ["Seth, A."], year: 2013, type: "review", abstract: "A full abstract.", citations: 420, retracted: true,
    topics: [{ id: "T1", name: "Interoception" }], oaUrl: "https://papers.example.org/full.pdf", raw: { id: "https://openalex.org/W77", ids: { pmid: "777" } },
  })).work;
const run = (projectId: string): Run => ({
  id: crypto.randomUUID(), projectId, mode: "search", query: "later", seedProfileId: null, inputIds: [], filters: { ...DEFAULT_FILTERS },
  status: "completed", createdAt: now(), updatedAt: now(), calls: 0, maxCalls: 0, maxCandidates: 0, total: 0, count: 0, message: "", tasks: [], rankingVersion: "t",
});

test("the surviving record keeps what only the removed one knew, here and in projects it was not in", () =>
  fixture((db) => {
    const projectId = db.projects()[0].id;
    const full = provider(db);
    db.mutate(projectId, [full.id], { screening: "excluded", reading: "read", note: "not relevant", starred: true });
    const sparse = db.upsert(blankWork({ title: "Interoceptive inference in the anterior insula (PDF)", source: "pdf" })).work;

    mergeWorks(db, sparse.id, full.id);
    const kept = db.get(sparse.id);
    expect(kept).toMatchObject({
      title: sparse.title, abstract: "A full abstract.", pmid: "777", year: 2013, citations: 420, openalex: "W77", doi: "10.7777/full",
      type: "review", retracted: true, oaUrl: "https://papers.example.org/full.pdf",
    });
    expect(kept.topics).toHaveLength(1);
    expect((kept.raw as { ids?: unknown }).ids).toEqual({ pmid: "777" });
    // It was only the removed record's state in this project: it is not sent back to the review queue.
    expect(db.state(projectId, sparse.id)).toMatchObject({ screening: "excluded", reading: "read", note: "not relevant", starred: true });
  }));

test("undoing a merge restores the two records and leaves later work on other things alone", () =>
  fixture((db) => {
    const projectId = db.projects()[0].id;
    const keep = db.upsert(blankWork({ title: "Dopamine and reward prediction error", doi: "10.7777/keep", source: "manual" })).work;
    const remove = db.upsert(blankWork({ title: "Dopamine and reward prediction error (preprint)", doi: "10.7777/remove", source: "manual", abstract: "Preprint abstract." })).work;
    const bystander = db.upsert(blankWork({ title: "An unrelated paper on hearing", source: "manual" })).work;
    db.mutate(projectId, [keep.id], { screening: "included", note: "keep note" });
    db.mutate(projectId, [remove.id, bystander.id], { screening: "pending" });
    const seeded = run(projectId);
    seeded.inputIds = [remove.id];
    db.saveRun(seeded);
    const before = { keep: db.get(keep.id), remove: db.get(remove.id), keepState: db.state(projectId, keep.id), removeState: db.state(projectId, remove.id) };

    mergeWorks(db, keep.id, remove.id);
    expect(db.run(seeded.id).inputIds).toEqual([keep.id]);
    // What the merge remembers is these two papers, not the library.
    const stored = db.db.prepare("SELECT data FROM merge_history WHERE id=1").get() as { data: string };
    expect(JSON.parse(stored.data).works.map((w: { id: string }) => w.id).sort()).toEqual([keep.id, remove.id].sort());
    expect(stored.data).not.toContain(bystander.title);

    // Work that does not count as a library edit: another run, and progress on the run the merge rewrote.
    const later = run(projectId);
    db.saveRun(later);
    const resumed = db.run(seeded.id);
    resumed.message = "resumed after the merge";
    db.saveRun(resumed);

    expect(undoMerge(db)).toBe(true);
    expect(db.get(keep.id)).toEqual(before.keep);
    expect(db.get(remove.id)).toEqual(before.remove);
    expect(db.state(projectId, keep.id)).toEqual(before.keepState);
    expect(db.state(projectId, remove.id)).toEqual(before.removeState);
    expect(db.findIdentifier("doi", "10.7777/remove")).toBe(remove.id);
    expect(db.run(later.id).id).toBe(later.id);
    expect(db.run(seeded.id).message).toBe("resumed after the merge");
    expect(db.db.pragma("foreign_key_check")).toEqual([]);
    expect(undoMerge(db)).toBe(false);
  }));

test("conversations follow a merged paper and return with an undo", () =>
  fixture((db) => {
    const projectId = db.projects()[0].id;
    const keep = db.upsert(blankWork({ title: "Hearing aids and cognitive decline", source: "manual" })).work;
    const remove = db.upsert(blankWork({ title: "Hearing aids and cognitive decline (duplicate)", source: "manual" })).work;
    const chats = new ChatStore(db);
    const session = chats.create(projectId, remove.id, ABSTRACT_CONTEXT);
    session.messages.push({ id: "m1", role: "user", content: "What was the sample size?", createdAt: now(), status: "complete" });
    chats.save(session);

    mergeWorks(db, keep.id, remove.id);
    const moved = chats.load(projectId, keep.id, ABSTRACT_CONTEXT);
    expect(moved).toMatchObject({ threadId: session.threadId, workId: keep.id });
    expect(moved.messages[0].content).toBe("What was the sample size?");

    expect(undoMerge(db)).toBe(true);
    expect(chats.load(projectId, remove.id, ABSTRACT_CONTEXT)).toMatchObject({ threadId: session.threadId, workId: remove.id });
    expect(chats.list(projectId, keep.id, ABSTRACT_CONTEXT).some((t) => t.threadId === session.threadId)).toBe(false);
  }));

test("the undo history survives a paper that was merged away or deleted", () =>
  fixture((db) => {
    const projectId = db.projects()[0].id;
    const keep = db.upsert(blankWork({ title: "Sleep spindles and memory consolidation", source: "manual" })).work;
    const remove = db.upsert(blankWork({ title: "Sleep spindles and memory consolidation (copy)", source: "manual" })).work;
    const gone = db.upsert(blankWork({ title: "A record deleted outright", source: "manual" })).work;
    db.mutate(projectId, [keep.id, remove.id, gone.id], { screening: "included" }, false);
    db.mutate(projectId, [keep.id], { note: "first" });
    db.mutate(projectId, [remove.id], { starred: true });
    db.mutate(projectId, [gone.id], { starred: true });
    mergeWorks(db, keep.id, remove.id);
    db.db.pragma("foreign_keys=OFF");
    for (const table of ["project_works", "identifiers", "metadata_snapshots", "works"])
      db.db.prepare(`DELETE FROM ${table} WHERE ${table === "works" ? "id" : "work_id"}=?`).run(gone.id);
    db.db.pragma("foreign_keys=ON");

    // Neither step blocks the ones recorded before it.
    expect(db.undo(projectId)).toBe(true);
    expect(db.undo(projectId)).toBe(true);
    expect(db.state(projectId, keep.id).note).toBe("first");
    expect(db.undo(projectId)).toBe(true);
    expect(db.state(projectId, keep.id).note).toBe("");
  }));

test("a .bib entry for a paper a provider already described does not reset what the provider reported", () =>
  fixture((db) => {
    const known = provider(db);
    const again = db.upsert(blankWork({ source: "bibtex", doi: "10.7777/full", title: known.title, type: "article", bibFields: { keywords: "insula" } })).work;
    expect(again.id).toBe(known.id);
    expect(again).toMatchObject({ retracted: true, type: "review", source: "openalex", abstract: "A full abstract." });
    expect((again.raw as { id?: string }).id).toBe("https://openalex.org/W77");
    expect(again.bibFields).toEqual({ keywords: "insula" });
  }));

test("restoring a backup leaves a linked PDF that is still in place as a link", () =>
  fixture(async (db, root) => {
    const work = db.upsert(blankWork({ title: "A paper with a linked PDF", source: "manual" })).work;
    const path = join(root, "shelf", "linked.pdf");
    await Bun.write(path, await readFile(fixturePdf));
    const size = (await readFile(path)).length;
    const attachment: Attachment = { id: crypto.randomUUID(), workId: work.id, name: "linked.pdf", path, hash: await hashFile(path), mode: "linked", size, status: "연결됨", exists: true };
    db.saveAttachment(attachment);
    for (const includeLinked of [false, true]) {
      const backup = await createBackup(db, join(root, `backup-${includeLinked}`), true, includeLinked);
      const restored = await restoreBackup(backup.path, join(root, `restored-${includeLinked}`));
      const copy = new Library(restored.path);
      try {
        expect(copy.attachments(work.id)[0]).toMatchObject({ path, mode: "linked", exists: true });
        expect(restored.missing).toEqual([]);
      } finally {
        copy.close();
      }
    }
  }));

test("a PDF found through a page's own links must prove it is the paper; the declared one need not", async () => {
  const landing = "https://journal.example.org/article/1";
  expect(citationPdfUrls(`<meta name="citation_pdf_url" content="/article/1.pdf"><a href="/guide.pdf">Author guidelines</a>`, landing)).toEqual(["https://journal.example.org/article/1.pdf"]);
  const pdf = await readFile(fixturePdf);
  const root = await mkdtemp(join(tmpdir(), "researchbunny-identity-"));
  try {
    const seen = async (html: string) => {
      const engine = new FulltextEngine(async (url) => (String(url).endsWith(".pdf") ? new Response(pdf) : new Response(html, { headers: { "content-type": "text/html" } })), async () => {});
      let retrieved: RetrievedPdf | undefined;
      await engine.retrieve(blankWork({ title: "Some paper", url: landing }), join(root, "x.part"), new AbortController().signal, () => {}, async (r) => { retrieved = r; });
      return retrieved!;
    };
    expect((await seen(`<a href="/files/guide.pdf">Author guidelines</a>`)).requireIdentity).toBe(true);
    expect((await seen(`<meta name="citation_pdf_url" content="/article/1.pdf">`)).requireIdentity).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciling finished downloads in the background never counts as a job in progress", () =>
  fixture(async (db, root) => {
    const projectId = db.projects()[0].id;
    const work = db.upsert(blankWork({ title: "Packaged PDF extraction fixture", url: "https://papers.example.org/paper" })).work;
    db.mutate(projectId, [work.id], { screening: "included" });
    const jobs = new PdfDownloads(db, worker, () => {}, new FulltextEngine(async () => new Response("missing", { status: 404 }), async () => {}), { async retrieve() { throw new AppError("CHROME_CONTROL", "lost tab"); } });
    try {
      const first = jobs.start({ projectId, scope: "archive", useBrowser: true, downloadDirectory: root });
      for (let i = 0; i < 2000 && jobs.active.size; i++) await Bun.sleep(5);
      expect(db.run(first.id).download!.items[0].status).toBe("failed");
      await copyFile(fixturePdf, join(root, "saved-later.pdf"));
      // A file still being written is left alone; this one was saved a while ago.
      const saved = new Date(Date.now() - 5000);
      await utimes(join(root, "saved-later.pdf"), saved, saved);

      let busy = 0;
      const recovering = jobs.recoverCompleted();
      // Two timer ticks close together do the work once.
      const second = jobs.recoverCompleted();
      for (let i = 0; i < 400 && !db.attachments(work.id).length; i++) { busy = Math.max(busy, jobs.active.size); await Bun.sleep(5); }
      await Promise.all([recovering, second]);
      expect(busy).toBe(0);
      expect(db.attachments(work.id)).toHaveLength(1);
      expect(db.run(first.id).download!.items[0].status).toBe("completed");
    } finally {
      jobs.stopRecoveryMonitor();
    }
  }));
