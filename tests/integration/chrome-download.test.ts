import { test } from "bun:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { blankWork } from "../../src/shared/domain";
import { AppError } from "../../src/shared/types";
import { ChromeDownloads, browserFetchScript, chromeControlError, type ChromeControl } from "../../src/service/fulltext/chrome";
import { PdfDownloads } from "../../src/service/fulltext/jobs";
import { FulltextEngine } from "../../src/service/fulltext/engine";
import { Library } from "../../src/service/db/database";

const fixturePdf = resolve("tests/fixtures/synthetic-local.pdf");
const pdf = await readFile(fixturePdf);
const worker = resolve("dist/runtime/pdf-worker.cjs");
const work = blankWork({title:"Browser session article", url:"https://papers.example.org/article", doi:"10.1234/browser"});
const tab = {windowId:"7", tabId:"42"};

test("real-session driver waits for its blank tab to navigate, collects its download and preserves old files", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-"));
  const saved = join(root, "saved.part"), actions: string[] = [];
  let probes = 0;
  await copyFile(fixturePdf, join(root, "already-here.pdf"));
  const chrome: ChromeControl = {
    async open(url) { actions.push(url); return tab; },
    async probe() {
      if (++probes <= 2) return {url:"about:blank", ready:"complete", challenge:false, links:[]};
      return {url:work.url!, ready:"complete", challenge:false, links:["http://127.0.0.1/private.pdf", "https://papers.example.org/source.pdf"], state:"done"};
    },
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
    const run = jobs.start({projectId, scope:"archive", useBrowser:true, downloadDirectory:root});
    for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
    assert.equal(jobs.active.size, 0); assert.equal(browserCalls, 1); assert.equal(warnings, 1);
    assert(db.run(run.id).download!.items.every(item => item.status === "completed"));
    assert.equal(db.run(run.id).download!.useBrowser, true);
  } finally {
      for (const control of jobs.active.values()) control.abort();
      for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
      db.close(); await rm(root, {recursive:true, force:true});
    }
});

test("Chrome errors distinguish closed tabs, timeouts, execution errors and disabled JavaScript", () => {
  const closed = chromeControlError('execution error: Can’t get tab id 42 of window id 7. (-1728)');
  assert.equal(closed.code, "CHROME_TAB_CLOSED");
  assert.equal(closed.retryable, true);
  assert(closed.message.includes("-1728"));
  assert.equal(chromeControlError('execution error: AppleEvent timed out. (-1712)').code, "CHROME_TIMEOUT");
  assert.equal(chromeControlError('', true).code, "CHROME_TIMEOUT");
  assert.equal(chromeControlError('execution error: JavaScript execution failed. (-10000)').code, "CHROME_CONTROL");
  assert.equal(chromeControlError('Executing JavaScript through AppleScript is turned off. Allow JavaScript from Apple Events. (-10000)').code, "CHROME_JAVASCRIPT");
  assert.equal(chromeControlError('Apple Events를 통한 JavaScript가 꺼져 있습니다. (-10000)').code, "CHROME_JAVASCRIPT");
  assert.equal(chromeControlError('Not authorized to send Apple events to Google Chrome. (-1743)').code, "CHROME_PERMISSION");
});

for (const code of ["CHROME_CONTROL", "CHROME_TAB_CLOSED", "CHROME_TIMEOUT"]) {
  test(`${code} affects only one paper and the next paper still downloads through Chrome`, async () => {
    const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-recovery-"));
    const db = new Library(join(root, "library"));
    const projectId = db.projects()[0].id;
    for (let i = 0; i < 2; i++) {
      const w = db.upsert(blankWork({title:`Browser recovery ${i}`, url:`https://papers.example.org/${i}`})).work;
      db.mutate(projectId, [w.id], {screening:"included", note:"preserved"});
    }
    let browserCalls = 0, publicCalls = 0, warnings = 0;
    const jobs = new PdfDownloads(db, worker, event => { if (event.type === "service-error") warnings++; }, new FulltextEngine(async () => {
      publicCalls++;
      return new Response("unavailable", {status:404});
    }, async () => {}), {
      async retrieve(_work, path, _signal, _progress, validate) {
        if (++browserCalls === 1) throw new AppError(code, "Temporary Chrome failure", true);
        await writeFile(path, pdf);
        const candidate = {sourceUrl:"https://papers.example.org/real.pdf", doi:null, method:"chrome" as const};
        await validate(candidate);
        return candidate;
      },
    });
    try {
      const run = jobs.start({projectId, scope:"archive", useBrowser:true, downloadDirectory:root});
      for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
      assert.equal(jobs.active.size, 0);
      assert.equal(browserCalls, 2);
      assert(publicCalls > 0);
      assert.equal(warnings, 0);
      const final = db.run(run.id);
      assert.equal(final.status, "completed");
      assert.deepEqual(final.download!.items.map(item => item.status), ["failed", "completed"]);
      assert.equal(final.download!.items[0].message, "Temporary Chrome failure");
      assert.equal(final.download!.items[1].retrievalMethod, "chrome");
      assert.equal(db.state(projectId, final.download!.items[1].workId).note, "preserved");
    } finally {
      for (const control of jobs.active.values()) control.abort();
      for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
      db.close(); await rm(root, {recursive:true, force:true});
    }
  });
}

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
    const run = jobs.start({projectId, scope:"archive", useBrowser:true, downloadDirectory:root});
    for (let i = 0; i < 100 && !calls; i++) await Bun.sleep(5);
    jobs.control(run.id, "skip");
    for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
    assert.equal(jobs.active.size, 0); assert.equal(calls, 2);
    assert.equal(db.run(run.id).status, "completed");
    assert.deepEqual(db.run(run.id).download!.items.map(item => item.status), ["skipped", "completed"]);
  } finally {
      for (const control of jobs.active.values()) control.abort();
      for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
      db.close(); await rm(root, {recursive:true, force:true});
    }
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
