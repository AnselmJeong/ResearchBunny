import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { PdfDownloads } from "../../src/service/fulltext/jobs";
import { ChromeDownloads, type BrowserRetrieval } from "../../src/service/fulltext/chrome";
import type { BrowserDownload, BrowserTab } from "../../src/service/fulltext/chrome-host";
import { FulltextEngine, SciHubError, sciHubChallenge, sciHubMirrors, sciHubUrl, type DownloadFetch } from "../../src/service/fulltext/engine";
import { blankWork } from "../../src/shared/domain";
import { AppError } from "../../src/shared/types";

const pdf = await readFile(resolve("tests/fixtures/synthetic-local.pdf"));
const worker = resolve("dist/runtime/pdf-worker.cjs");
const storage = "https://sci-hub.test/storage/2024/6384/f8d4/drevets2008.pdf";
// Trimmed from the live pages: the robot check, and the article page (which also carries an ALTCHA report form).
const robot = `<!DOCTYPE html><html><head><title translate = "ko:title">로봇 확인</title><script src="/scripts/altcha.min.js"></script></head>
<body><div class="question"><altcha-widget challengeurl="/captcha/challenge/5190072" hidelogo></altcha-widget></div><img src="/pictures/robot.svg"></body></html>`;
const article = `<!DOCTYPE html><html><head><title>Sci-Hub. The Subgenual Anterior Cingulate Cortex in Mood Disorders</title>
<meta name="citation_doi" content="10.1017/S1092852900013754"><meta name="citation_pdf_url" content="/storage/2024/6384/f8d4/drevets2008.pdf"></head>
<body><div class="pdf"><object type = "application/pdf" data = "/storage/2024/6384/f8d4/drevets2008.pdf#navpanes=0&view=FitH"></object></div>
<altcha-widget challengeurl="/captcha/challenge/1"></altcha-widget><div class="download"><a href="/storage/2024/6384/f8d4/drevets2008.pdf"></a></div></body></html>`;
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=UTF-8" } });
const engine = (fetcher: DownloadFetch) => new FulltextEngine(fetcher, async () => {});
const work = blankWork({ title: "The subgenual anterior cingulate cortex in mood disorders", doi: "10.1017/S1092852900013754", year: 2008 });

test("mirror settings normalize to origins and build the DOI page in the mirror/https://doi.org/DOI form", () => {
  assert.equal(sciHubUrl("https://sci-hub.kr", "10.1017/S1092852900013754"), "https://sci-hub.kr/https://doi.org/10.1017/S1092852900013754");
  assert.equal(sciHubUrl("https://sci-hub.kr", "10.1002/(sici)1097#x?y"), "https://sci-hub.kr/https://doi.org/10.1002/(sici)1097%23x%3Fy");
  assert.deepEqual(sciHubMirrors(["sci-hub.kr", "https://sci-hub.kr/", " https://sci-hub.box ", "http://mirror.example.org/scihub/"]),
    ["https://sci-hub.kr", "https://sci-hub.box", "http://mirror.example.org/scihub"]);
  for (const bad of ["localhost", "http://127.0.0.1", "ftp://sci-hub.kr", "", "https://user:pass@sci-hub.kr"])
    assert.throws(() => sciHubMirrors([bad]), (error: unknown) => error instanceof AppError && error.code === "SCIHUB_MIRROR", bad);
  assert.equal(sciHubChallenge(robot), true);
  assert.equal(sciHubChallenge(article), false, "the article page's report form is not a robot check");
  assert.equal(sciHubChallenge("<title>DDoS-Guard</title>"), true);
});

test("a robot check moves on to the next mirror, whose article page leads to the storage PDF", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-scihub-engine-"));
  const requests: string[] = [], progress: string[] = [];
  try {
    const path = join(root, "pdf.part");
    const result = await engine(async url => {
      requests.push(url);
      if (url.startsWith("https://sci-hub.kr/")) return html(robot);
      if (url.startsWith("https://sci-hub.test/https://doi.org/")) return html(article);
      if (url === storage) return new Response(pdf, { headers: { "content-type": "application/pdf" } });
      return new Response("not found", { status: 404 });
    }).sciHub(work, ["https://sci-hub.kr", "https://sci-hub.test"], path, new AbortController().signal, message => progress.push(message));
    // DOIs are stored lowercased; doi.org and the mirrors match them case-insensitively.
    assert.deepEqual(requests, ["https://sci-hub.kr/https://doi.org/10.1017/s1092852900013754", "https://sci-hub.test/https://doi.org/10.1017/s1092852900013754", storage]);
    assert.deepEqual(result, { sourceUrl: storage, doi: "10.1017/s1092852900013754", method: "http", mirror: "sci-hub.test" });
    assert.deepEqual(await readFile(path), pdf);
    assert(progress.some(message => message.includes("Sci-Hub 미러 확인 · sci-hub.kr")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a robot check is reported with its page for Chrome, a missing article is final, and no DOI asks Crossref first", async () => {
  const signal = new AbortController().signal, path = join(tmpdir(), `rb-scihub-${Date.now()}.part`);
  await assert.rejects(engine(async () => html(robot)).sciHub(work, ["https://sci-hub.kr", "https://sci-hub.box"], path, signal, () => {}),
    (error: unknown) => error instanceof SciHubError && error.code === "SCIHUB_CHALLENGE" && error.page === "https://sci-hub.kr/https://doi.org/10.1017/s1092852900013754");
  await assert.rejects(engine(async () => html("<title>Sci-Hub: article not found</title>")).sciHub(work, ["https://sci-hub.kr"], path, signal, () => {}),
    (error: unknown) => error instanceof SciHubError && error.code === "SCIHUB_MISSING" && !error.page);
  await assert.rejects(engine(async () => new Response("<title>DDoS-Guard</title>", { status: 403 })).sciHub(work, ["https://sci-hub.st"], path, signal, () => {}),
    (error: unknown) => error instanceof SciHubError && error.code === "SCIHUB_BLOCKED" && !!error.page);
  const requests: string[] = [];
  const untitled = blankWork({ title: work.title, year: 2008, authors: ["Drevets, Wayne C."] });
  await assert.rejects(engine(async url => {
    requests.push(url);
    if (url.includes("api.crossref")) return new Response(JSON.stringify({ message: { items: [{ DOI: "10.1017/S1092852900013754", title: [work.title], author: [{ family: "Drevets" }], issued: { "date-parts": [[2008]] } }] } }));
    return html(robot);
  }).sciHub(untitled, ["https://sci-hub.kr"], path, signal, () => {}));
  assert.equal(requests[1], "https://sci-hub.kr/https://doi.org/10.1017/s1092852900013754");
  await assert.rejects(engine(async () => new Response(JSON.stringify({ message: { items: [] } }))).sciHub(blankWork({ title: "Unknown" }), ["https://sci-hub.kr"], path, signal, () => {}),
    (error: unknown) => error instanceof SciHubError && error.code === "SCIHUB_NO_DOI");
});

async function library(fn: (db: Library, projectId: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "rb-scihub-job-"));
  const db = new Library(join(root, "library"));
  try { await fn(db, db.projects()[0].id, root); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
async function finish(jobs: PdfDownloads) {
  for (let i = 0; i < 4000 && jobs.active.size; i++) await Bun.sleep(5);
  assert.equal(jobs.active.size, 0, "download must reach a terminal state");
}
// Every ordinary route fails: the paper's own PDF, Unpaywall and its DOI page.
const closed = (sciHub: (url: string) => Response | undefined, requests: string[] = []) => engine(async url => {
  requests.push(url);
  if (url.includes("api.unpaywall")) return new Response("{}");
  return sciHub(url) || new Response("paywalled", { status: 403 });
});

test("Sci-Hub runs only after the other routes fail, is remembered with its mirrors, and records the mirror", () => library(async (db, projectId) => {
  const paper = db.upsert(blankWork({ title: "Sci-Hub fallback paper", doi: "10.1234/scihub-fallback", oaUrl: "https://papers.example.org/closed.pdf" })).work;
  db.mutate(projectId, [paper.id], { screening: "included", note: "keep note" });
  const requests: string[] = [];
  const jobs = new PdfDownloads(db, worker, () => {}, closed(url => url.startsWith("https://sci-hub.test/https://doi.org/") ? html(article) : url === storage ? new Response(pdf) : undefined, requests));
  const off = jobs.start({ projectId, scope: "archive", useSciHub: false }); await finish(jobs);
  assert.equal(db.run(off.id).download!.items[0].status, "failed");
  assert(!requests.some(url => url.includes("sci-hub")), "a disabled fallback never contacts a mirror");
  assert.deepEqual(jobs.sciHub(), { enabled: false, mirrors: ["https://sci-hub.kr"] });

  const run = jobs.start({ projectId, scope: "archive", useSciHub: true, sciHubMirrors: ["sci-hub.test/"] }); await finish(jobs);
  const item = db.run(run.id).download!.items[0];
  assert.equal(item.status, "completed", item.message);
  assert(item.message.startsWith("Sci-Hub(sci-hub.test)에서 PDF 확보"), item.message);
  assert.equal(item.sourceUrl, storage);
  assert.equal(db.attachments(paper.id)[0].sourceUrl, storage);
  assert.equal(db.state(projectId, paper.id).note, "keep note");
  assert(requests.indexOf("https://papers.example.org/closed.pdf") < requests.indexOf("https://sci-hub.test/https://doi.org/10.1234/scihub-fallback"));
  assert.deepEqual(jobs.sciHub(), { enabled: true, mirrors: ["https://sci-hub.test"] });
  assert.deepEqual((await jobs.missing({ projectId, scope: "archive" })).sciHub, { enabled: true, mirrors: ["https://sci-hub.test"] });
  assert.equal(db.run(run.id).download!.useSciHub, true);
  assert.throws(() => jobs.start({ projectId, scope: "archive", useSciHub: true, sciHubMirrors: ["localhost"] }), (error: unknown) => error instanceof AppError && error.code === "SCIHUB_MIRROR");
}));

test("a robot check over HTTP opens the mirror page in Chrome for the person, and both failures are explained", () => library(async (db, projectId, root) => {
  const papers = [0, 1].map(i => db.upsert(blankWork({ title: `Robot checked paper ${i}`, doi: `10.1234/robot-${i}`, url: `https://papers.example.org/${i}` })).work);
  db.mutate(projectId, papers.map(p => p.id), { screening: "included" });
  const starts: (string | undefined)[] = [];
  const browser: BrowserRetrieval = {
    async retrieve(work, path, _signal, _progress, validate, { start }) {
      starts.push(start);
      // The publisher page fails in Chrome; the person passes the check on the first paper only.
      if (!start) throw new AppError("CHROME_UNAVAILABLE", "로그인된 Chrome에서도 PDF를 확보하지 못했습니다.");
      if (work.id === papers[1].id) throw new AppError("CHROME_CHALLENGE", "Chrome 사람 인증 대기 시간이 초과되어 다음 문헌으로 넘어갑니다.");
      await writeFile(path, pdf);
      const candidate = { sourceUrl: storage, doi: null, method: "chrome" as const };
      await validate(candidate);
      return candidate;
    },
  };
  db.pref("sciHub", { enabled: true, mirrors: ["https://sci-hub.kr"] });
  const jobs = new PdfDownloads(db, worker, () => {}, closed(url => url.startsWith("https://sci-hub.kr/") ? html(robot) : undefined), browser);
  const run = jobs.start({ projectId, scope: "archive", useBrowser: true, useSciHub: true, downloadDirectory: root }); await finish(jobs);
  const items = db.run(run.id).download!.items;
  const first = items.find(item => item.workId === papers[0].id)!, second = items.find(item => item.workId === papers[1].id)!;
  // Each paper: its own page in Chrome first, then the mirror page after the HTTP robot check.
  assert.deepEqual([starts[0], starts[2]], [undefined, undefined]);
  assert.deepEqual([starts[1], starts[3]].sort(), ["https://sci-hub.kr/https://doi.org/10.1234/robot-0", "https://sci-hub.kr/https://doi.org/10.1234/robot-1"]);
  assert.equal(first.status, "completed", first.message);
  assert(first.message.startsWith("Sci-Hub(sci-hub.kr) · Chrome에서 PDF 확보"), first.message);
  assert.equal(second.status, "failed");
  assert.equal(second.errorCode, "CHROME_CHALLENGE");
  assert(second.message.includes("로그인된 Chrome에서도") && second.message.includes("Sci-Hub(sci-hub.kr) · Chrome 사람 인증"), second.message);
}));

test("the Chrome driver opens the given mirror page instead of the paper's own page", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-scihub-chrome-"));
  const opened: string[] = [], found: BrowserDownload[] = [];
  const page = "https://sci-hub.kr/https://doi.org/10.1017/S1092852900013754";
  let directory = "";
  const tab: BrowserTab = {
    async collect(path) { directory = path; },
    downloads: () => found,
    async navigate(url) { opened.push(url); },
    async evaluate<T>(expression: string) {
      const filename = /a\.download = "([^"]+)"/.exec(expression)?.[1];
      if (!filename) return JSON.stringify({ url: page, ready: "complete", challenge: false, login: false, links: ["https://sci-hub.kr/storage/2024/drevets2008.pdf"] }) as T;
      // The storage PDF is same-origin, so the page fetches it with its own session.
      opened.push("fetch");
      await writeFile(join(directory, "guid"), pdf);
      found.push({ guid: "guid", url: "blob:https://sci-hub.kr/x", suggestedFilename: filename, state: "completed", path: join(directory, "guid"), receivedBytes: pdf.length, totalBytes: pdf.length });
      return "started" as T;
    },
    async cancel() {}, async reveal() { throw new Error("no robot check here"); }, async reset() {}, async close() {},
  };
  try {
    const result = await new ChromeDownloads({ tab: async () => tab, idle: async () => {} }, { pollMs: 5 })
      .retrieve(blankWork({ ...work, url: "https://www.cambridge.org/core/article" }), join(root, "saved.part"), new AbortController().signal, () => {}, async () => {}, { downloads: root, start: page });
    assert.deepEqual(opened, [page, "fetch"]);
    assert.equal(result.method, "chrome");
    assert.equal(result.sourceUrl, "https://sci-hub.kr/storage/2024/drevets2008.pdf");
  } finally { await rm(root, { recursive: true, force: true }); }
});
