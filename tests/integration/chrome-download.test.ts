import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { blankWork } from "../../src/shared/domain";
import { AppError } from "../../src/shared/types";
import { ChromeDownloads, browserFetchScript, type ChromeProbe, type RetrievalOptions } from "../../src/service/fulltext/chrome";
import type { BrowserDownload, BrowserHost, BrowserTab } from "../../src/service/fulltext/chrome-host";
import { PdfDownloads } from "../../src/service/fulltext/jobs";
import { FulltextEngine } from "../../src/service/fulltext/engine";
import { Library } from "../../src/service/db/database";

const fixturePdf = resolve("tests/fixtures/synthetic-local.pdf");
const pdf = await readFile(fixturePdf);
const worker = resolve("dist/runtime/pdf-worker.cjs");
const work = blankWork({title:"Browser session article", url:"https://papers.example.org/article", doi:"10.1234/browser"});
const fast = { budgetMs: 3000, pollMs: 5, autoMs: 40, challengeMs: 120, loginMs: 160 };

/** A fake work tab: `page` answers each probe; fetches and navigations to PDFs become finished downloads. */
class FakeTab implements BrowserTab {
  calls: string[] = [];
  revealed: string[] = [];
  found: BrowserDownload[] = [];
  url = "";
  private directory = "";
  constructor(private page: (tab: FakeTab) => Partial<ChromeProbe>, private pdfs: Record<string, string> = {}) {}
  async collect(directory: string) { this.calls.push("collect"); this.directory = directory; this.found = []; await mkdir(directory, {recursive:true}); }
  downloads() { return this.found; }
  private async download(url: string, suggestedFilename: string) {
    const guid = `guid-${this.found.length + 1}`;
    await writeFile(join(this.directory, guid), pdf);
    this.found.push({guid, url, suggestedFilename, state:"completed", path:join(this.directory, guid)});
  }
  async navigate(url: string) {
    this.calls.push(`navigate ${url}`);
    if (this.pdfs[url]) await this.download(url, this.pdfs[url]); else this.url = url;
  }
  async evaluate<T>(expression: string): Promise<T> {
    const filename = /a\.download = "([^"]+)"/.exec(expression)?.[1];
    if (filename) { this.calls.push("fetch"); await this.download(`blob:${this.url}`, filename); return "started" as T; }
    return JSON.stringify({url:this.url, ready:"complete", challenge:false, login:false, links:[], ...this.page(this)}) as T;
  }
  async reveal(message: string) { this.revealed.push(message); }
  async reset() { this.calls.push("reset"); }
  async close() { this.calls.push("close"); }
}
function hostFor(tab: FakeTab): BrowserHost & { tabs: number; idles: number } {
  return { tabs: 0, idles: 0, async tab() { this.tabs++; return tab; }, async idle() { this.idles++; } };
}
async function scratch(run: (root: string, options: RetrievalOptions) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-"));
  try { await run(root, {downloads:join(root, "chrome", "item"), rejected:join(root, "rejected")}); }
  finally { await rm(root, {recursive:true, force:true}); }
}

test("the app's Chrome saves the page's own PDF into staging, reuses one tab, and releases it at the end", () => scratch(async (root, options) => {
  const tab = new FakeTab(() => ({links:["http://127.0.0.1/private.pdf", "https://papers.example.org/source.pdf"]}));
  const host = hostFor(tab), chrome = new ChromeDownloads(host, fast);
  const saved = join(root, "saved.part");
  const result = await chrome.retrieve(work, saved, new AbortController().signal, () => {}, async candidate => {
    assert.equal(candidate.requireIdentity, false, "the page's own fetch is this paper");
    assert.deepEqual(await readFile(saved), pdf);
  }, options);
  assert.equal(result.method, "chrome");
  assert.equal(result.sourceUrl, "https://papers.example.org/source.pdf", "the attachment records the PDF address, not the landing page");
  assert.deepEqual(tab.calls, ["collect", `navigate ${work.url}`, "fetch", "reset"]);
  assert.deepEqual(tab.revealed, [], "nothing asked the person");
  await chrome.retrieve(blankWork({title:"Second", url:"https://papers.example.org/second"}), saved, new AbortController().signal, () => {}, async () => {}, {...options, downloads:join(root, "chrome", "item-2")});
  assert.equal(host.tabs, 2, "the host hands back its one work tab");
  await chrome.release();
  assert.equal(tab.calls.at(-1), "close");
  assert.equal(host.idles, 1);
}));

test("a download that turns out to be another paper is set aside for the run, and the paper keeps looking", () => scratch(async (root, options) => {
  const tab = new FakeTab(() => ({links:["https://cdn.example.net/other.pdf", "https://cdn.example.net/right.pdf"]}), {
    "https://cdn.example.net/other.pdf": "other.pdf", "https://cdn.example.net/right.pdf": "right.pdf",
  });
  const chrome = new ChromeDownloads(hostFor(tab), fast);
  let checks = 0;
  const result = await chrome.retrieve(work, join(root, "saved.part"), new AbortController().signal, () => {}, async candidate => {
    assert.equal(candidate.requireIdentity, true, "a download the page started on its own needs the DOI/title check");
    if (++checks === 1) throw new AppError("WRONG_PDF", "another paper");
  }, options);
  assert.equal(result.sourceUrl, "https://cdn.example.net/right.pdf");
  assert.deepEqual(await readdir(join(root, "rejected")), ["guid-1.pdf"]);
}));

test("robot checks get a few seconds to clear on their own, then the window is shown once; unattended runs never show it", () => scratch(async (root, options) => {
  // Clears by itself: no window.
  let probes = 0;
  let tab = new FakeTab(() => ++probes < 4 ? {challenge:true} : {links:["https://papers.example.org/a.pdf"]});
  await new ChromeDownloads(hostFor(tab), {...fast, autoMs:1000}).retrieve(work, join(root, "a.part"), new AbortController().signal, () => {}, async () => {}, options);
  assert.deepEqual(tab.revealed, []);

  // Stays: shown once, then the paper moves on.
  tab = new FakeTab(() => ({challenge:true}));
  const messages: string[] = [];
  await assert.rejects(new ChromeDownloads(hostFor(tab), fast).retrieve(work, join(root, "b.part"), new AbortController().signal, message => messages.push(message), async () => {}, options),
    (error: unknown) => error instanceof AppError && error.code === "CHROME_CHALLENGE");
  assert.deepEqual(tab.revealed, ["앱 전용 Chrome에서 사람 인증을 완료하세요"]);
  assert(messages.some(message => message.includes("초 후 다음 문헌으로 이동")));

  // A sign-in page is shown at once, and waits longer.
  tab = new FakeTab(() => ({login:true}));
  await assert.rejects(new ChromeDownloads(hostFor(tab), fast).retrieve(work, join(root, "c.part"), new AbortController().signal, () => {}, async () => {}, options),
    (error: unknown) => error instanceof AppError && error.code === "CHROME_LOGIN");
  assert.deepEqual(tab.revealed, ["앱 전용 Chrome에서 기관·출판사 로그인을 완료하세요"]);

  // Nobody watching: never shown.
  for (const page of [{challenge:true}, {login:true}]) {
    tab = new FakeTab(() => page);
    await assert.rejects(new ChromeDownloads(hostFor(tab), fast).retrieve(work, join(root, "d.part"), new AbortController().signal, () => {}, async () => {}, {...options, interactive:false}),
      (error: unknown) => error instanceof AppError && ["CHROME_CHALLENGE", "CHROME_LOGIN"].includes(error.code) && error.message.includes("재시도"));
    assert.deepEqual(tab.revealed, []);
  }
}));

test("cancellation interrupts the wait for the app's Chrome before any page opens", async () => {
  const control = new AbortController();
  const host: BrowserHost = {
    tab: signal => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true})),
    async idle() {},
  };
  const job = new ChromeDownloads(host, fast).retrieve(work, "/unused", control.signal, () => {}, async () => {}, {downloads:"/unused"});
  control.abort(new AppError("DOWNLOAD_SKIPPED", "skip"));
  await assert.rejects(job, (error: unknown) => error instanceof AppError && error.code === "DOWNLOAD_SKIPPED");
});

test("public copies come before Chrome, a Chrome that cannot start is reported once, and the run releases the browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-job-"));
  const db = new Library(join(root, "library"));
  const projectId = db.projects()[0].id;
  const papers = [0, 1, 2].map(i => db.upsert(blankWork({title:`Browser fallback ${i}`, oaUrl:`https://papers.example.org/${i}.pdf`})).work);
  db.mutate(projectId, papers.map(w => w.id), {screening:"included"});
  let browserCalls = 0, warnings = 0, released = 0;
  const seen: RetrievalOptions[] = [];
  // Only the first paper has a public copy.
  const engine = new FulltextEngine(async url => url.endsWith("/0.pdf") ? new Response(pdf) : new Response("missing", {status:404}), async () => {});
  const jobs = new PdfDownloads(db, worker, event => { if (event.type === "service-error") warnings++; }, engine, {
    async retrieve(_work, _path, _signal, _progress, _validate, options) { browserCalls++; seen.push(options); throw new AppError("CHROME_LAUNCH", "Chrome did not start"); },
    async release() { released++; },
  });
  try {
    const run = jobs.start({projectId, scope:"archive", useBrowser:true, downloadDirectory:root});
    for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
    assert.equal(jobs.active.size, 0); assert.equal(browserCalls, 1); assert.equal(warnings, 1); assert.equal(released, 1);
    const items = db.run(run.id).download!.items, item = (i: number) => items.find(it => it.workId === papers[i].id)!;
    assert.equal(item(0).status, "completed"); assert.equal(item(0).retrievalMethod, "http");
    for (const i of [1, 2]) { assert.equal(item(i).status, "failed"); assert.equal(item(i).errorCode, "CHROME_LAUNCH"); }
    // Browser downloads land in the run's own staging, which the run removes.
    assert(seen[0].downloads.startsWith(join(db.root, "downloads", run.id, "chrome")));
    assert.equal(seen[0].rejected, join(db.root, "downloads", run.id, "chrome-rejected"));
    assert.equal(seen[0].interactive, true);
    assert.equal(db.run(run.id).download!.useBrowser, true);
  } finally {
      for (const control of jobs.active.values()) control.abort();
      for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
      db.close(); await rm(root, {recursive:true, force:true});
    }
});


for (const code of ["CHROME_CLOSED", "CHROME_TIMEOUT", "CHROME_PROTOCOL"]) {
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
  const jobs = new PdfDownloads(db, worker, () => {}, new FulltextEngine(async () => new Response("missing", {status:404}), async () => {}), {
    async retrieve(_work, path, signal, _progress, validate) {
      if (++calls === 1) { await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true})); throw Error("unreachable"); }
      await writeFile(path, pdf); const candidate = {sourceUrl:"https://papers.example.org/real.pdf", doi:null}; await validate(candidate); return candidate;
    },
  });
  try {
    const run = jobs.start({projectId, scope:"archive", useBrowser:true, downloadDirectory:root});
    // The public route runs first; skip once the paper has reached Chrome.
    for (let i = 0; i < 4000 && !calls; i++) await Bun.sleep(5);
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

