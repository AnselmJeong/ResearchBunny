import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Library } from "../../src/service/db/database";
import { LinkedDiscoveries, type LinkedNeighborhood } from "../../src/service/providers/linked-discoveries";
import { OpenAlex, fromOpenAlex } from "../../src/service/providers/openalex";
import { Discovery } from "../../src/service/discovery/engine";
import { Service } from "../../src/service/service";
import { blankWork, normalizePmid, pmidOf } from "../../src/shared/domain";
import { AppError, DEFAULT_FILTERS, now, type LinkedSize, type Run, type Work } from "../../src/shared/types";
import { schemas } from "../../src/shared/contracts";
import fixture from "../fixtures/linked-discoveries-38772598.json";

type Fetcher = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
const signal = () => new AbortController().signal;
const session = () => new Response("page", { headers: { "set-cookie": "other=1; Path=/, linked-discoveries-csrftoken=abc123; Path=/; SameSite=Lax" } });
async function withDb(fn: (db: Library, root: string) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-linked-"));
  const db = new Library(join(root, "library"));
  try { await fn(db, root); }
  finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
function envelope(pmids = ["101", "102"]): LinkedNeighborhood {
  return {
    seedPmid: "38772598", cached: false, fetchedAt: now(),
    entities: { diseases: {}, genes: {}, chemicals: {} },
    neighbors: pmids.map((pmid, i) => ({ pmid, score: 0.72 - i * 0.05, isReview: i === 0, isRetracted: false, diseases: [], genes: [], chemicals: [] })),
  };
}
class StubLinked extends LinkedDiscoveries {
  requests: { pmid: string; size: LinkedSize }[] = [];
  error?: AppError;
  result = envelope();
  override async neighbors(pmid: string, size: LinkedSize, s: AbortSignal, onCall: () => void) {
    s.throwIfAborted();
    onCall();
    this.requests.push({ pmid, size });
    if (this.error) throw this.error;
    return this.result;
  }
}
function harness(db: Library, seeds: Work[]) {
  const requests: string[] = [];
  const oa = new OpenAlex(db, () => undefined, async (input) => {
    const u = new URL(String(input));
    const filter = u.searchParams.get("filter") || "";
    requests.push(filter || u.pathname);
    const pmids = filter.startsWith("pmid:") ? filter.slice(5).split("|") : [];
    const results = pmids.map((p) => ({ id: `https://openalex.org/W${p}`, title: "Identical candidate title", ids: { pmid: `https://pubmed.ncbi.nlm.nih.gov/${p}/` } }));
    return Response.json({ results, meta: { count: results.length } });
  });
  const ld = new StubLinked(db);
  const engine = new Discovery(db, oa, () => {}, undefined, ld);
  const start = () => engine.start({ projectId: db.projects()[0].id, mode: "related", query: "", ids: seeds.map((s) => s.id), filters: DEFAULT_FILTERS });
  return { ld, engine, start, requests };
}
const seed = (db: Library, pmid: string | null = "38772598") => db.upsert(blankWork({ openalex: "W" + (pmid || "99"), pmid, title: "Seed paper", references: [], related: ["W500"] })).work;
async function finished(db: Library, engine: Discovery, id: string): Promise<Run> {
  for (let i = 0; i < 2000; i++) {
    if (!engine.active.has(id)) return db.run(id);
    await Bun.sleep(5);
  }
  throw new Error("Discovery did not finish");
}

test("PMID normalization, legacy raw fallback, and identifier merge preserve library state", () => withDb((db) => {
  for (const value of ["38772598", " PMID: 38772598 ", "https://pubmed.ncbi.nlm.nih.gov/38772598/"])
    assert.equal(normalizePmid(value), "38772598");
  for (const value of ["0", "-1", "12/34", "pmid:bad", "https://evil.example/38772598", null]) assert.equal(normalizePmid(value), null);
  const work = fromOpenAlex({ id: "https://openalex.org/W1", title: "Same paper", ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/38772598" } });
  assert.equal(work.pmid, "38772598");
  const first = db.upsert(work).work;
  const projectId = db.projects()[0].id;
  db.mutate(projectId, [first.id], { screening: "included", note: "Keep classifications and notes" });
  const second = db.upsert(blankWork({ pmid: "pmid:38772598", title: "Same paper" })).work;
  assert.equal(first.id, second.id);
  assert.equal(db.findIdentifier("pmid", "38772598"), first.id);
  assert.equal(db.state(projectId, first.id).note, "Keep classifications and notes");
  const legacy = { ...first };
  delete (legacy as Partial<Work>).pmid;
  db.db.prepare("UPDATE works SET data=? WHERE id=?").run(JSON.stringify(legacy), first.id);
  assert.equal(pmidOf(legacy), "38772598");
  assert.equal(db.get(first.id).pmid, "38772598");
}));

test("provider parses CSRF, sorts and deduplicates neighbors, excludes seed and caches only reduced data", () => withDb(async (db) => {
  let calls = 0;
  const requests: { url: string; init?: RequestInit }[] = [];
  const provider = new LinkedDiscoveries(db, async (url, init) => {
    requests.push({ url: String(url), init });
    if (init?.method === "GET") return session();
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Cookie"), "linked-discoveries-csrftoken=abc123");
    assert.equal(headers.get("X-CSRFToken"), "abc123");
    assert.match(headers.get("User-Agent")!, /^ResearchBunny\//);
    assert.equal(init?.body, "neighbors=20");
    return Response.json({ ...fixture, articles: [...fixture.articles, fixture.articles[1]], unknownFutureField: true });
  });
  const result = await provider.neighbors("38772598", 20, signal(), () => calls++);
  assert.equal(result.neighbors.length, 10);
  assert(!result.neighbors.some((n) => n.pmid === "38772598"));
  assert.deepEqual(result.neighbors.map((n) => n.score), result.neighbors.map((n) => n.score).sort((a, b) => b - a));
  const cached = await new LinkedDiscoveries(db, async () => { throw new Error("Must not fetch"); }).neighbors("38772598", 20, signal(), () => calls++);
  assert(cached.cached);
  assert.equal(calls, 2);
  assert.equal(requests.length, 2);
  const stored = JSON.stringify(db.cacheGet("ld:v1:38772598:20"));
  assert(!/title|abstract|authors|unknownFutureField/.test(stored));
}));

test("provider refreshes CSRF exactly once on 403, then fails without an infinite retry", () => withDb(async (db) => {
  const methods: string[] = [];
  const ld = new LinkedDiscoveries(db, async (_, init) => {
    methods.push(init!.method!);
    return init?.method === "GET" ? session() : new Response("Forbidden", { status: 403 });
  });
  await assert.rejects(ld.neighbors("38772598", 20, signal(), () => {}), { code: "PROVIDER" });
  assert.deepEqual(methods, ["GET", "POST", "GET", "POST"]);
}));

test("provider recovers from a single stale CSRF token", () => withDb(async (db) => {
  let posts = 0;
  const ld = new LinkedDiscoveries(db, async (_, init) => init?.method === "GET" ? session()
    : ++posts === 1 ? new Response("Forbidden", { status: 403 }) : Response.json(fixture));
  assert.equal((await ld.neighbors("38772598", 20, signal(), () => {})).neighbors.length, 10);
  assert.equal(posts, 2);
}));

for (const [name, response, code] of [
  ["400", () => new Response("Invalid form data", { status: 400 }), "PROVIDER"],
  ["429", () => new Response("rate limit", { status: 429 }), "RATE_LIMIT"],
  ["broken required schema", () => Response.json({ articles: [{ articleId: "123", score: "0.7", isSeed: false }] }), "PROVIDER_SCHEMA"],
  ["invalid JSON", () => new Response("<html>"), "PROVIDER_SCHEMA"],
] as const) test(`provider handles ${name}`, () => withDb(async (db) => {
  let posts = 0;
  const ld = new LinkedDiscoveries(db, async (_, init) => init?.method === "GET" ? session() : (posts++, response()));
  await assert.rejects(ld.neighbors("38772598", 20, signal(), () => {}), { code });
  assert.equal(posts, 1);
}));

test("provider accepts empty/seed-only neighborhoods and optional field changes", () => withDb(async (db) => {
  const responses = [{ articles: [] }, { articles: [fixture.articles.find((a) => a.isSeed)] },
    { articles: [{ articleId: "101", score: 0.71, isSeed: false, genes: null, diseases: { future: true } }] }];
  const ld = new LinkedDiscoveries(db, async (_, init) => init?.method === "GET" ? session() : Response.json(responses.shift()));
  assert.equal((await ld.neighbors("1", 20, signal(), () => {})).neighbors.length, 0);
  assert.equal((await ld.neighbors("38772598", 20, signal(), () => {})).neighbors.length, 0);
  assert.deepEqual((await ld.neighbors("3", 20, signal(), () => {})).neighbors[0].genes, []);
}));

test("provider retries network/5xx twice and serializes instances at least one second apart", () => withDb(async (db) => {
  const times: number[] = [];
  let active = 0, peak = 0, attempts = 0;
  const fetcher: Fetcher = async (_, init) => {
    times.push(Date.now()); active++; peak = Math.max(peak, active);
    await Bun.sleep(15); active--;
    if (init?.method === "GET") return session();
    if (++attempts === 1) throw new TypeError("network");
    if (attempts === 2) return new Response("upstream", { status: 503 });
    return Response.json(fixture);
  };
  const a = new LinkedDiscoveries(db, fetcher), b = new LinkedDiscoveries(db, fetcher);
  await Promise.all([a.neighbors("1", 20, signal(), () => {}), b.neighbors("2", 20, signal(), () => {})]);
  assert.equal(peak, 1);
  assert.equal(attempts, 4);
  for (let i = 1; i < times.length; i++) assert(times[i] - times[i - 1] >= 990);
}));

test("provider cancellation while queued prevents calls and does not block later requests", () => withDb(async (db) => {
  let calls = 0;
  const ld = new LinkedDiscoveries(db, async (_, init) => init?.method === "GET" ? session() : Response.json(fixture));
  const controller = new AbortController();
  const pending = ld.neighbors("38772598", 20, controller.signal, () => calls++);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(calls, 0);
  assert.equal((await ld.neighbors("38772598", 20, signal(), () => {})).neighbors.length, 10);
}));

test("PMID search routes through works/pmid and preserves PMID in candidate", () => withDb(async (db) => {
  const oa = new OpenAlex(db, () => undefined, async (url) => {
    assert.equal(new URL(String(url)).pathname, "/works/pmid:38772598");
    return Response.json({ id: "https://openalex.org/W1", ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/38772598" } });
  });
  const engine = new Discovery(db, oa, () => {});
  const run = engine.start({ projectId: db.projects()[0].id, mode: "search", query: "PMID:38772598", ids: [], filters: DEFAULT_FILTERS });
  assert.equal((await finished(db, engine, run.id)).status, "completed");
  assert.equal(db.candidates(run.id)[0].work.pmid, "38772598");
}));

test("linked expansion takes precedence, ranks by similarity, preserves deferred label, and broadens on more", () => withDb(async (db) => {
  db.pref("linkedDiscoveries", true);
  const s = seed(db);
  const h = harness(db, [s]);
  const run = await finished(db, h.engine, h.start().id);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.tasks.slice(0, 2).map((t) => t.kind), ["linked", "pmidBatch"]);
  assert.equal(h.ld.requests[0].size, 100);
  assert(!h.requests.some((r) => r.startsWith("openalex:")));
  const candidates = db.candidates(run.id);
  assert.equal(candidates[0].work.pmid, "101");
  assert(candidates[0].evidence.deferred);
  assert(candidates[0].evidence.reasons.includes("PubMed 의미 이웃 · 유사도 0.72"));
  assert(candidates[0].evidence.origins.includes("PubMed 의미 이웃"));
  assert.equal(db.usageSummary().find((u) => u.provider === "linked-discoveries")?.calls, 1);
  h.ld.result = envelope(["101", "102", "103"]);
  h.engine.control(run.id, "more");
  const more = await finished(db, h.engine, run.id);
  assert.equal(more.count, 3);
  assert.equal(h.ld.requests[1].size, 200);
  h.engine.control(run.id, "more");
  await finished(db, h.engine, run.id);
  assert.equal(h.ld.requests.length, 2);
}));

test("relevance filtering retains strong semantic neighbors even when query text does not overlap", () => withDb(async (db) => {
  db.pref("linkedDiscoveries", true);
  const h = harness(db, [seed(db)]);
  const run = await finished(db, h.engine, h.start().id);
  for (const candidate of db.candidates(run.id))
    db.edit(candidate.work.id, { abstract: "Molecular treatment evidence" });
  h.engine.rank(run);
  const visible = db.list({ projectId: run.projectId, scope: "run", scopeId: run.id,
    query: "", filters: { ...DEFAULT_FILTERS, relevance: true }, showHidden: false, offset: 0, limit: 100, sort: "rank" });
  assert.equal(visible.works.length, 2);
  assert(visible.works.every((w) => !w.evidence?.deferred && (w.evidence?.score || 0) > 0.075));
}));

test("multiple seeds merge Linked evidence and use adaptive neighborhood sizes", () => withDb(async (db) => {
  db.pref("linkedDiscoveries", true);
  const seeds = [seed(db, "1"), seed(db, "2")];
  const h = harness(db, seeds);
  const run = await finished(db, h.engine, h.start().id);
  const e = db.candidates(run.id)[0].evidence;
  assert.deepEqual(e.linked?.seedIds.sort(), seeds.map((s) => s.id).sort());
  assert.equal(e.linked?.score, 0.72);
  assert(e.reasons.includes("PubMed 의미 이웃 · 출발 문헌 2편 공통"));
  assert(h.ld.requests.every((r) => r.size === 50));
  run.inputIds.push(seed(db, "3").id, seed(db, "4").id);
  assert(h.engine.makeTasks(run).filter((t) => t.kind === "linked").every((t) => t.size === 20));
}));

for (const enabled of [undefined, false, true]) test(`legacy/off settings and PMID-less seeds keep original tasks (${enabled})`, () => withDb(async (db) => {
  if (enabled !== undefined) db.pref("linkedDiscoveries", enabled);
  const h = harness(db, [seed(db, enabled ? null : "38772598")]);
  const run = await finished(db, h.engine, h.start().id);
  assert.equal(run.status, "completed");
  assert.equal(h.ld.requests.length, 0);
  assert(h.requests.includes("openalex:W500"));
  assert.deepEqual(run.tasks.map((t) => t.kind), ["search", "cites", "batch", "cites"]);
}));

for (const empty of [false, true]) test(`failed/empty Linked neighborhood falls back with a completion notice (${empty})`, () => withDb(async (db) => {
  db.pref("linkedDiscoveries", true);
  const h = harness(db, [seed(db)]);
  if (empty) h.ld.result = envelope([]);
  else h.ld.error = new AppError("PROVIDER_SCHEMA", "Changed schema");
  const run = await finished(db, h.engine, h.start().id);
  assert.equal(run.status, "completed");
  assert.match(run.message, /PubMed 의미 이웃 미조회 1편/);
  assert(h.requests.includes("openalex:W500"));
}));

for (const code of ["RATE_LIMIT", "BUDGET"]) test(`${code} pauses Linked work and resume completes without fallback`, () => withDb(async (db) => {
  db.pref("linkedDiscoveries", true);
  const h = harness(db, [seed(db)]);
  h.ld.error = new AppError(code, "Pause");
  const run = await finished(db, h.engine, h.start().id);
  assert.equal(run.status, "paused_budget");
  assert(!run.tasks[0].done);
  assert(!h.requests.includes("openalex:W500"));
  h.ld.error = undefined;
  h.engine.control(run.id, "resume");
  assert.equal((await finished(db, h.engine, run.id)).status, "completed");
  assert.equal(db.candidates(run.id).length, 2);
}));

test("settings default off, save/reopen persistence, old payload preservation, and safe Inspector URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-linked-settings-"));
  let service = new Service(root, resolve("dist/runtime/pdf-worker.cjs"), () => {});
  try {
    assert.equal(service.settings().linkedDiscoveries, false);
    const settings = schemas.saveSettings.parse({ ...service.settings(), linkedDiscoveries: true });
    await service.call("saveSettings", settings);
    service.db.close();
    service = new Service(root, resolve("dist/runtime/pdf-worker.cjs"), () => {});
    assert.equal(service.settings().linkedDiscoveries, true);
    const oldPayload = { ...settings };
    delete oldPayload.linkedDiscoveries;
    await service.call("saveSettings", schemas.saveSettings.parse(oldPayload));
    assert.equal(service.settings().linkedDiscoveries, true);
    const work = seed(service.db);
    await service.call("saveSettings", { ...settings, linkedDiscoveries: false });
    assert.equal(await service.call("externalUrl", { workId: work.id, kind: "linked-discoveries" }), "https://linkeddiscoveries.ncbi.nlm.nih.gov/38772598/");
    assert(schemas.openExternal.safeParse({ workId: work.id, kind: "linked-discoveries" }).success);
  } finally { service.db.close(); await rm(root, { recursive: true, force: true }); }
});
