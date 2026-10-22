import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library } from "../../src/service/db/database";
import { OpenAlex } from "../../src/service/providers/openalex";
import { LinkedDiscoveries } from "../../src/service/providers/linked-discoveries";
import { Links, type SimilarSource } from "../../src/service/discovery/links";
import { Service } from "../../src/service/service";
import { blankWork } from "../../src/shared/domain";
import { now, type LinkedSize, type Work } from "../../src/shared/types";
import { schemas } from "../../src/shared/contracts";

const raw = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `https://openalex.org/W${n}`,
  title: `Paper ${n}`,
  publication_year: 2000 + (n % 20),
  cited_by_count: n,
  authorships: [{ author: { display_name: `Author ${n}` } }],
  referenced_works: [],
  related_works: [],
  ...extra,
});
async function withDb(fn: (db: Library) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-links-"));
  const db = new Library(join(root, "library"));
  try { await fn(db); }
  finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
/** OpenAlex answering openalex:/pmid:/cites: filters and DOI lookups from a table of raw works. */
function provider(db: Library, works: Record<string, unknown>[], citing: Record<string, unknown>[] = []) {
  const requests: string[] = [];
  const oa = new OpenAlex(db, () => undefined, async (input) => {
    const url = new URL(String(input));
    const filter = url.searchParams.get("filter") || "";
    requests.push(filter ? `${filter}${url.searchParams.get("cursor") && url.searchParams.get("cursor") !== "*" ? ` cursor=${url.searchParams.get("cursor")}` : ""}${url.searchParams.get("sort") ? ` sort=${url.searchParams.get("sort")}` : ""}` : url.pathname);
    if (url.pathname.startsWith("/works/")) {
      const match = works.find((w) => url.pathname.includes(String((w as { doi?: string }).doi || "").replace("https://doi.org/", "")));
      return match ? Response.json(match) : new Response("", { status: 404 });
    }
    if (filter.startsWith("cites:")) {
      const first = (url.searchParams.get("cursor") || "*") === "*";
      return Response.json({ results: first ? citing.slice(0, 2) : citing.slice(2), meta: { count: citing.length, next_cursor: first ? "page2" : null } });
    }
    const [key, values] = [filter.slice(0, filter.indexOf(":")), filter.slice(filter.indexOf(":") + 1).split("|")];
    const results = works.filter((w) => key === "pmid"
      ? values.some((v) => String((w.ids as { pmid?: string } | undefined)?.pmid || "").endsWith(`/${v}/`))
      : values.includes(String(w.id).replace("https://openalex.org/", "")));
    return Response.json({ results, meta: { count: results.length } });
  });
  return { oa, requests };
}
class StubLinked extends LinkedDiscoveries {
  calls: { pmid: string; size: LinkedSize }[] = [];
  override async neighbors(pmid: string, size: LinkedSize, signal: AbortSignal, onCall: () => void) {
    signal.throwIfAborted();
    onCall();
    this.calls.push({ pmid, size });
    return {
      seedPmid: pmid, cached: false, fetchedAt: now(),
      entities: { diseases: {}, genes: {}, chemicals: {} },
      neighbors: [{ pmid: "702", score: 0.6 }, { pmid: "701", score: 0.9 }].map((n) => ({ ...n, isReview: false, isRetracted: false, diseases: [], genes: [], chemicals: [] })),
    };
  }
}
const stored = (db: Library, n: number, extra: Partial<Work> = {}) =>
  db.upsert(blankWork({ openalex: `W${n}`, title: `Paper ${n}`, year: 2000 + (n % 20), citations: n, references: [], ...extra })).work;
const members = (db: Library, projectId: string) =>
  (db.db.prepare("SELECT work_id FROM project_works WHERE project_id=?").all(projectId) as { work_id: string }[]).map((r) => r.work_id);

test("references list every cited paper, fetch only the missing ones once, and leave the review queue alone", async () => {
  await withDb(async (db) => {
    const projectId = db.projects()[0].id;
    const kept = stored(db, 11);
    db.mutate(projectId, [kept.id], { screening: "included" });
    const seed = stored(db, 1, { references: ["W11", "W12", "W13", "W99"] });
    const { oa, requests } = provider(db, [raw(12), raw(13)]);
    const links = new Links(db, oa, new StubLinked(db));
    const result = await links.load({ projectId, workId: seed.id, mode: "references", sort: "citations" });
    expect(requests).toEqual(["openalex:W12|W13|W99"]);
    const [group] = result.groups;
    expect(group.items.map((w) => w.title)).toEqual(["Paper 13", "Paper 12", "Paper 11"]);
    expect(group.total).toBe(4);
    expect(group.note).toContain("1편");
    expect(group.items.find((w) => w.title === "Paper 11")?.screening).toBe("included");
    // Listing a paper stores it, but only saving puts it in the project.
    expect(members(db, projectId)).toEqual([kept.id]);
    const byYear = await links.load({ projectId, workId: seed.id, mode: "references", sort: "year" });
    expect(byYear.groups[0].items.map((w) => w.year)).toEqual([2013, 2012, 2011]);
    // W99 is unknown to OpenAlex, so the second listing asks for it alone and nothing else.
    expect(requests).toEqual(["openalex:W12|W13|W99", "openalex:W99"]);
  });
});

test("citing papers put the archive and shelf first, page through OpenAlex, and follow the sort", async () => {
  await withDb(async (db) => {
    const projectId = db.projects()[0].id;
    const seed = stored(db, 1);
    const mine = stored(db, 21, { references: ["W1"] });
    db.mutate(projectId, [mine.id], { screening: "included" });
    // A stored paper that cites the seed but is not kept stays in the OpenAlex group.
    stored(db, 22, { references: ["W1"] });
    const { oa, requests } = provider(db, [], [raw(21), raw(23), raw(24)]);
    const links = new Links(db, oa, new StubLinked(db));
    const first = await links.load({ projectId, workId: seed.id, mode: "citedBy", sort: "citations" });
    expect(first.groups.map((g) => g.key)).toEqual(["local", "citing"]);
    expect(first.groups[0].items.map((w) => w.title)).toEqual(["Paper 21"]);
    expect(first.groups[1].items.map((w) => w.title)).toEqual(["Paper 23"]);
    expect(first.groups[1]).toMatchObject({ total: 3, cursor: "page2" });
    const more = await links.load({ projectId, workId: seed.id, mode: "citedBy", sort: "citations", cursor: "page2" });
    expect(more.groups.map((g) => g.key)).toEqual(["citing"]);
    expect(more.groups[0].items.map((w) => w.title)).toEqual(["Paper 24"]);
    await links.load({ projectId, workId: seed.id, mode: "citedBy", sort: "year" });
    expect(requests).toEqual(["cites:W1 sort=cited_by_count:desc", "cites:W1 cursor=page2 sort=cited_by_count:desc", "cites:W1 sort=publication_date:desc"]);
    expect(members(db, projectId)).toEqual([mine.id]);
  });
});

test("related papers merge the shelf, PubMed neighbours and OpenAlex related works without repeats", async () => {
  await withDb(async (db) => {
    const projectId = db.projects()[0].id;
    db.pref("linkedDiscoveries", true);
    const onShelf = stored(db, 31);
    const seed = stored(db, 1, { pmid: "700", related: ["W31", "W41", "W42"] });
    const { oa, requests } = provider(db, [
      raw(41), raw(42),
      raw(51, { ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/701/" } }),
      raw(42, { ids: { pmid: "https://pubmed.ncbi.nlm.nih.gov/702/" } }),
    ]);
    const shelf: SimilarSource = {
      enabled: () => true,
      similar: async (workId) => ({ hits: workId === seed.id ? [{ workId: onShelf.id, score: 0.81 }] : [], notice: "" }),
    };
    const ld = new StubLinked(db);
    const result = await new Links(db, oa, ld, shelf).load({ projectId, workId: seed.id, mode: "related", sort: "citations" });
    expect(ld.calls).toEqual([{ pmid: "700", size: 20 }]);
    expect(result.groups.map((g) => [g.key, g.items.map((w) => w.title)])).toEqual([
      ["shelf", ["Paper 31"]],
      ["pubmed", ["Paper 51", "Paper 42"]],
      ["openalex", ["Paper 41"]],
    ]);
    expect(result.groups[0].items[0].score).toBe(0.81);
    expect(result.groups[1].items.map((w) => w.score)).toEqual([0.9, 0.6]);
    expect(requests).toEqual(["pmid:702|701", "openalex:W41"]);
    expect(members(db, projectId)).toEqual([]);
  });
});

test("a paper without identifiers explains why nothing is listed and calls no provider", async () => {
  await withDb(async (db) => {
    const projectId = db.projects()[0].id;
    const local = db.upsert(blankWork({ title: "Local note", source: "manual" })).work;
    const { oa, requests } = provider(db, []);
    const links = new Links(db, oa, new StubLinked(db));
    for (const mode of ["references", "citedBy", "related"] as const) {
      const result = await links.load({ projectId, workId: local.id, mode, sort: "citations" });
      expect(result.groups.every((g) => !g.items.length)).toBe(true);
      expect(result.notices.join(" ")).toContain("DOI");
    }
    expect(requests).toEqual([]);
  });
});

test("a paper with only a DOI is looked up first, then its references are listed", async () => {
  await withDb(async (db) => {
    const projectId = db.projects()[0].id;
    const imported = db.upsert(blankWork({ doi: "10.1000/seed", title: "Paper 1", source: "bibtex", references: null })).work;
    const { oa, requests } = provider(db, [raw(1, { doi: "https://doi.org/10.1000/seed", referenced_works: ["https://openalex.org/W61"] }), raw(61)]);
    const result = await new Links(db, oa, new StubLinked(db)).load({ projectId, workId: imported.id, mode: "references", sort: "citations" });
    expect(requests).toEqual(["/works/https://doi.org/10.1000/seed", "openalex:W61"]);
    expect(result.groups[0].items.map((w) => w.title)).toEqual(["Paper 61"]);
    expect(db.get(imported.id)).toMatchObject({ openalex: "W1", references: ["W61"] });
  });
});

test("budget errors stop the list so it can be retried", async () => {
  await withDb(async (db) => {
    const projectId = db.projects()[0].id;
    const seed = stored(db, 1, { references: ["W71"] });
    const oa = new OpenAlex(db, () => undefined, async () => new Response("", { status: 429, headers: { "x-ratelimit-remaining": "0" } }));
    await expect(new Links(db, oa, new StubLinked(db)).load({ projectId, workId: seed.id, mode: "references", sort: "citations" }))
      .rejects.toMatchObject({ code: "DAILY_BUDGET" });
  });
});

test("the workLinks command validates input and answers through the service", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-links-service-"));
  const service = new Service(root, "unused", () => {});
  try {
    const projectId = service.db.projects()[0].id;
    const seed = stored(service.db, 1, { references: ["W81"] });
    service.oa.page = async () => ({ works: [], cursor: null, total: 0, cached: false, fetchedAt: now() });
    service.db.upsert(blankWork({ openalex: "W81", title: "Paper 81", references: [] }));
    expect(schemas.workLinks.safeParse({ projectId, workId: seed.id, mode: "graph" }).success).toBe(false);
    const result = await service.call("workLinks", schemas.workLinks.parse({ projectId, workId: seed.id, mode: "references" }));
    expect(result.groups[0].items.map((w: { title: string }) => w.title)).toEqual(["Paper 81"]);
  } finally {
    await service.call("shutdown", {});
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
