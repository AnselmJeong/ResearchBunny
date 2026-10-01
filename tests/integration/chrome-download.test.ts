import { test } from "bun:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { blankWork } from "../../src/shared/domain";
import { AppError } from "../../src/shared/types";
import { ChromeDownloads, browserFetchScript, type ChromeControl } from "../../src/service/fulltext/chrome";
import { PdfDownloads } from "../../src/service/fulltext/jobs";
import { FulltextEngine } from "../../src/service/fulltext/engine";
import { Library } from "../../src/service/db/database";

const fixturePdf = resolve("tests/fixtures/synthetic-local.pdf");
const pdf = await readFile(fixturePdf);
const worker = resolve("dist/runtime/pdf-worker.cjs");
const work = blankWork({title:"Browser session article", url:"https://papers.example.org/article", doi:"10.1234/browser"});
const tab = {windowId:"7", tabId:"42"};

test("real-session driver collects its unique browser download and preserves old Downloads files", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-"));
  const saved = join(root, "saved.part"), actions: string[] = [];
  await copyFile(fixturePdf, join(root, "already-here.pdf"));
  const chrome: ChromeControl = {
    async open(url) { actions.push(url); return tab; },
    async probe() { return {url:work.url!, ready:"complete", challenge:false, links:["http://127.0.0.1/private.pdf", "https://papers.example.org/source.pdf"], state:"done"}; },
    async navigate() { throw new Error("same-origin PDF should use session fetch"); },
    async download(owned, url, filename) { assert.deepEqual(owned, tab); actions.push(url); await writeFile(join(root, filename), pdf); },
    async close(owned) { assert.deepEqual(owned, tab); actions.push("closed"); },
  };
  try {
    const result = await new ChromeDownloads(chrome, async () => [root], 2000, 10).retrieve(work, saved, new AbortController().signal, () => {}, async candidate => {
      assert.equal(candidate.requireIdentity, false);
      assert.deepEqual(await readFile(saved), pdf);
    });
    assert.equal(result.sourceUrl, "https://papers.example.org/source.pdf");
    assert.equal(result.method, "chrome");
    assert.deepEqual(actions, [work.url, result.sourceUrl, "closed"]);
    assert((await readdir(root)).some(name => name.startsWith("researchbunny-") && name.endsWith(".pdf")));
    assert.deepEqual(await readFile(join(root, "already-here.pdf")), pdf);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test("unrelated new downloads require identity and browser timeouts close only the owned tab", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-timeout-"));
  let closed = 0, validated = 0;
  const chrome: ChromeControl = {
    async open() { await writeFile(join(root, "unrelated.pdf"), pdf); return tab; },
    async probe() { return {url:work.url!, ready:"complete", challenge:true, links:[]}; },
    async navigate() {}, async download() {}, async close() { closed++; },
  };
  try {
    await assert.rejects(new ChromeDownloads(chrome, async () => [root], 100, 5).retrieve(work, join(root, "save.part"), new AbortController().signal, () => {}, async candidate => {
      validated++;
      assert.equal(candidate.requireIdentity, true);
      throw new AppError("WRONG_PDF", "unrelated");
    }), (error: unknown) => (error as Error).name === "TimeoutError");
    assert.equal(closed, 1); assert.equal(validated, 1);
    assert.deepEqual(await readFile(join(root, "unrelated.pdf")), pdf);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test("browser permission failures are shown once per run and public retrieval continues for later papers", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-job-"));
  const db = new Library(join(root, "library"));
  const projectId = db.projects()[0].id;
  for (let i = 0; i < 2; i++) { const w = db.upsert(blankWork({title:`Browser fallback ${i}`, oaUrl:`https://papers.example.org/${i}.pdf`})).work; db.mutate(projectId, [w.id], {screening:"included"}); }
  let browserCalls = 0, warnings = 0;
  const jobs = new PdfDownloads(db, worker, event => { if (event.type === "service-error") warnings++; }, new FulltextEngine(async () => new Response(pdf), async () => {}), {
    async retrieve() { browserCalls++; throw new AppError("CHROME_PERMISSION", "Permission required"); },
  });
  try {
    const run = jobs.start({projectId, scope:"archive", useBrowser:true});
    for (let i = 0; i < 1000 && jobs.active.size; i++) await Bun.sleep(5);
    assert.equal(jobs.active.size, 0); assert.equal(browserCalls, 1); assert.equal(warnings, 1);
    assert(db.run(run.id).download!.items.every(item => item.status === "completed"));
    assert.equal(db.run(run.id).download!.useBrowser, true);
  } finally { db.close(); await rm(root, {recursive:true, force:true}); }
});

test("skipping one browser item advances the batch and cancellation is distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-skip-"));
  const db = new Library(join(root, "library"));
  const projectId = db.projects()[0].id;
  for (let i = 0; i < 2; i++) { const w = db.upsert(blankWork({title:`Browser skip ${i}`, url:`https://papers.example.org/${i}`})).work; db.mutate(projectId, [w.id], {screening:"included"}); }
  let calls = 0;
  const jobs = new PdfDownloads(db, worker, () => {}, new FulltextEngine(async () => { throw Error("HTTP must not be used"); }, async () => {}), {
    async retrieve(_work, path, signal, _progress, validate) {
      if (++calls === 1) { await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true})); throw Error("unreachable"); }
      await writeFile(path, pdf); const candidate = {sourceUrl:"https://papers.example.org/real.pdf", doi:null}; await validate(candidate); return candidate;
    },
  });
  try {
    const run = jobs.start({projectId, scope:"archive", useBrowser:true});
    for (let i = 0; i < 100 && !calls; i++) await Bun.sleep(5);
    jobs.control(run.id, "skip");
    for (let i = 0; i < 1000 && jobs.active.size; i++) await Bun.sleep(5);
    assert.equal(jobs.active.size, 0); assert.equal(calls, 2);
    assert.equal(db.run(run.id).status, "completed");
    assert.deepEqual(db.run(run.id).download!.items.map(item => item.status), ["skipped", "completed"]);
  } finally { db.close(); await rm(root, {recursive:true, force:true}); }
});

test("page download uses browser credentials, bounds response size, and quotes URL and filename as data", () => {
  const url = 'https://example.org/a.pdf?q=";throw Error(1);//';
  const script = browserFetchScript(url, 'quoted"file.pdf');
  assert(script.includes(JSON.stringify(url)));
  assert(script.includes("credentials:'include'"));
  assert(script.includes("157286400"));
  assert(script.includes("controller.abort(), 15000"));
  assert.doesNotThrow(() => new Function(script));
});

test("cancellation also interrupts a blocked Chrome folder lookup before opening any tab", async () => {
  const control = new AbortController();
  let opened = false;
  const chrome: ChromeControl = {
    async open() { opened = true; return tab; }, async probe() { throw Error("not reached"); },
    async navigate() {}, async download() {}, async close() {},
  };
  const job = new ChromeDownloads(chrome, async () => new Promise(() => {})).retrieve(work, "/unused", control.signal, () => {}, async () => {});
  control.abort(new AppError("DOWNLOAD_SKIPPED", "skip"));
  await assert.rejects(job, (error:unknown) => error instanceof AppError && error.code === "DOWNLOAD_SKIPPED");
  assert.equal(opened, false);
});
