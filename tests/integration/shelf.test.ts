import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readdir, stat, rename, rm, copyFile, utimes } from "node:fs/promises";
import { basename, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../../src/service/service";
import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import { AppError, DEFAULT_FILTERS, type Run, type Work, type ListResult, type MissingPdfs } from "../../src/shared/types";
import { hasValidPdf } from "../../src/service/interchange/pdf";
import { mergeWorks, undoMerge } from "../../src/service/db/merge";
import { deleteTrashedWorks } from "../../src/service/db/trash";
import { parseShelfFilename, extractAbstractCandidate, SHELF_ALL, SHELF_INBOX, SHELF_REVIEW } from "../../src/shared/shelf";
import { planScan } from "../../src/service/shelf/scanner";
import { slimRaw } from "../../src/service/shelf/resolver";
import { VectorIndex } from "../../src/service/shelf/vectors";
import { normalize } from "../../src/service/providers/ollama-local";
import type { Page } from "../../src/service/providers/openalex";
import { chunksOf, fakeOllama, pdf } from "./shelf-helpers";

const worker = resolve("dist/runtime/pdf-worker.cjs");
const ABSTRACT_SMITH = "Abstract Interoception, the sensing of internal bodily signals such as the heartbeat, shapes emotional experience. We tested whether interoceptive prediction errors explain anxiety in a large cohort using heartbeat detection tasks, computational modelling of cardiac signals and questionnaires. Higher prediction errors predicted trait anxiety and panic symptoms across two independent samples, supporting a predictive processing account of anxiety disorders.";

const SMITH = "01 Domain A/Leaf X/2024 - Smith et al. - Interoceptive prediction errors in anxiety.pdf";
const KIM = "01 Domain A/Leaf Y/2023 - Kim, Lee - Dopamine dynamics and memory-guided behavior.pdf";
const PARK = "02 Domain B/2022 - Park et al. - Hearing intervention for older adults with mild cognitive impairment.pdf";
const SUPP = "2021 - Unknown - Supplementary material for interoception study.pdf";
const LOST = "2020 - Nobody - A completely unresolvable gardening manuscript about quantum soil.pdf";
const COPY = "01 Domain A/Leaf Y/2024 - Smith et al. - Interoceptive prediction errors in anxiety (copy).pdf";

async function buildShelf(dir: string) {
  await pdf(join(dir, SMITH), ["Interoceptive prediction errors in anxiety", "John Smith, Mary Jones", "doi: 10.1000/intero", ...chunksOf(ABSTRACT_SMITH), "Introduction", "Earlier work 10.9999/cited showed liver enzymes."]);
  await pdf(join(dir, KIM), ["Dopamine dynamics and memory-guided behavior", "Min Kim and J Lee", "Hippocampal dopamine release supports memory guided navigation in mice."]);
  await pdf(join(dir, PARK), ["Hearing intervention for older adults with mild cognitive impairment", "S Park", "Background: hearing aids and cognition. Cited 10.9999/parktrap."]);
  await pdf(join(dir, SUPP), ["Supplementary Information", "Tables S1 to S4 for the interoception study"]);
  await pdf(join(dir, LOST), ["A completely unresolvable gardening manuscript about quantum soil", "No identifiers here."]);
  await pdf(join(dir, "_system/ignored.pdf"), ["Internal tool file"]);
  await mkdir(join(dir, "01 Domain A/Leaf Y"), { recursive: true });
  await copyFile(join(dir, SMITH), join(dir, COPY));
}
async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else { const s = await stat(full); out.push(`${relative(dir, full)}|${s.size}|${Math.trunc(s.mtimeMs)}`); }
    }
  };
  await visit(dir);
  return out.sort();
}

function oaWork(fields: Partial<Work> & { openalex: string }): Work {
  return blankWork({
    source: "openalex",
    type: "article",
    url: `https://openalex.org/${fields.openalex}`,
    raw: { id: `https://openalex.org/${fields.openalex}`, ids: {}, counts_by_year: Array.from({ length: 50 }, (_, i) => ({ year: 1975 + i, cited_by_count: i })), concepts: [{ id: "C1", display_name: "x" }] },
    ...fields,
  });
}
const OA = {
  smith: oaWork({ openalex: "W100", doi: "10.1000/intero", title: "Interoceptive prediction errors in anxiety", authors: ["John Smith", "Mary Jones"], year: 2024, venue: "Journal of Interoception", abstract: "Interoception and heartbeat prediction errors explain anxiety and panic in two cohorts.", references: ["W200"] }),
  cited: oaWork({ openalex: "W900", doi: "10.9999/cited", title: "Liver enzyme kinetics in rodents", authors: ["Q Liver"], year: 2001 }),
  trap: oaWork({ openalex: "W901", doi: "10.9999/parktrap", title: "Cochlear implants in children", authors: ["Z Ear"], year: 2010 }),
  kim: oaWork({ openalex: "W200", doi: "10.2000/dopamine", title: "Dopamine dynamics and memory-guided behavior", authors: ["Min Kim", "J Lee"], year: 2023, abstract: "Hippocampal dopamine dynamics support memory guided behavior and navigation in mice." }),
  hearing: oaWork({ openalex: "W300", doi: "10.3000/hearing", title: "Hearing intervention for older adults with mild cognitive impairment", authors: ["Alice Brown"], year: 2022, abstract: "Hearing aids for older adults with mild cognitive impairment slowed decline." }),
  external: oaWork({ openalex: "W400", doi: "10.4000/other", title: "Heartbeat perception and anxiety in adolescents", authors: ["R Other"], year: 2025, abstract: "Interoception anxiety heartbeat adolescents." }),
};

async function fixture(fn: (ctx: { service: Service; dir: string; projectId: string; calls: { doi: number; search: number; lookup: number }; ollama: ReturnType<typeof fakeOllama>; root: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "rb-shelf-"));
  const dir = join(root, "Articles");
  await buildShelf(dir);
  const service = new Service(join(root, "library"), worker, () => {});
  const ollama = fakeOllama();
  const calls = { doi: 0, search: 0, lookup: 0 };
  const all = Object.values(OA);
  service.oa.page = async (params: Record<string, string>, _signal: AbortSignal, onCall: () => void): Promise<Page> => {
    onCall();
    const page = (works: Work[]): Page => ({ works: works.map((w) => structuredClone(w)), cursor: null, total: works.length, cached: false, fetchedAt: new Date().toISOString() });
    if (params.filter?.startsWith("doi:")) {
      calls.doi++;
      const dois = params.filter.slice(4).split("|");
      return page(all.filter((w) => w.doi && dois.includes(w.doi)));
    }
    calls.search++;
    const q = (params.search || "").toLowerCase();
    if (q.includes("dopamine")) return page([OA.kim]);
    if (q.includes("hearing")) return page([OA.hearing, OA.trap]);
    if (q.includes("heartbeat") || q.includes("interocept")) return page([OA.smith, OA.external]);
    return page([]);
  };
  service.oa.lookup = async (identifier: string, _signal: AbortSignal, onCall: () => void): Promise<Page> => {
    onCall();
    calls.lookup++;
    const found = all.find((w) => w.openalex === identifier || w.doi === identifier.toLowerCase());
    if (!found) throw new Error("not found");
    return { works: [structuredClone(found)], cursor: null, total: 1, cached: false, fetchedAt: new Date().toISOString() };
  };
  try {
    await fn({ service, dir, projectId: service.db.projects()[0].id, calls, ollama, root });
  } finally {
    service.shelf.stop();
    await service.shelf.wait();
    service.downloads.stopRecoveryMonitor();
    ollama.stop();
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function configure(service: Service, dir: string, ollamaUrl: string) {
  await service.call("shelfConfigure", { path: dir, ollamaUrl });
  await service.shelf.wait();
}
const fileOf = (service: Service, rel: string) =>
  (service.db.db.prepare("SELECT * FROM shelf_files WHERE rel_path=?").get(rel) ?? undefined) as { id: string; work_id: string; status: string; stage: string; info: string; hash: string; attachment_id: string | null; folder_id: string } | undefined;
const list = (service: Service, projectId: string, scope: string, scopeId?: string, filters = DEFAULT_FILTERS): ListResult =>
  service.db.list({ projectId, scope, scopeId, query: "", filters, showHidden: false, offset: 0, limit: 500, sort: "rank" });

test("filename parsing, abstract extraction, move planning and raw slimming", () => {
  expect(parseShelfFilename("2026 - Bauer-Negrini, et al. - ADHD and Late-Life Cognitive Impairment.pdf")).toEqual({ year: 2026, authors: ["Bauer-Negrini"], title: "ADHD and Late-Life Cognitive Impairment" });
  expect(parseShelfFilename("2026 - Bae, Cha - Neural Data Needs Semantic Tokenization; Behavioral Events - Boundaries.pdf")).toEqual({ year: 2026, authors: ["Bae", "Cha"], title: "Neural Data Needs Semantic Tokenization; Behavioral Events - Boundaries" });
  expect(parseShelfFilename("scan0001.pdf")).toBeNull();
  expect(extractAbstractCandidate(`Title here ${ABSTRACT_SMITH} Introduction The body.`)).toStartWith("Interoception, the sensing");
  expect(extractAbstractCandidate("Abstract Too short. Introduction")).toBeNull();
  const plan = planScan(
    [{ id: "a", rel_path: "x/a.pdf", size: 10, status: "ok" }, { id: "b", rel_path: "x/b.pdf", size: 20, status: "ok" }],
    { folders: ["", "y"], files: [{ rel: "y/a.pdf", folder: "y", size: 10, mtime: 1 }, { rel: "y/c.pdf", folder: "y", size: 30, mtime: 1 }] },
  );
  expect(plan.moves).toEqual([{ id: "a", to: { rel: "y/a.pdf", folder: "y", size: 10, mtime: 1 } }]);
  expect(plan.fresh.map((f) => f.rel)).toEqual(["y/c.pdf"]);
  expect(plan.vanished.map((r) => r.id)).toEqual(["b"]);
  const raw = slimRaw(OA.smith.raw);
  expect(raw.counts_by_year).toBeUndefined();
  expect(raw.concepts).toBeUndefined();
  expect(raw.ids).toEqual({});
});

test("vector index keeps rows consistent across upserts, removals and top-k", () => {
  const db = { db: { prepare: () => ({ all: () => [], run: () => {} }) } } as unknown as Library;
  const index = new VectorIndex(db);
  index.loaded = true;
  index.model = "m";
  for (let i = 0; i < 300; i++) index.upsert(`w${i}`, normalize([Math.cos(i / 50), Math.sin(i / 50), 0.1]));
  index.remove("w10");
  index.remove("w299");
  const top = index.search(normalize([1, 0, 0.1]), 3);
  expect(top.map((t) => t.id)).toEqual(["w0", "w1", "w2"]);
  expect(index.size).toBe(298);
  expect(index.vector("w10")).toBeNull();
  expect(index.search(normalize([1, 0, 0.1]), 2, (id) => id !== "w0").map((t) => t.id)).toEqual(["w1", "w2"]);
});

test("indexing is read-only and resolves files by DOI, title and review rules with linked PDFs and embeddings", async () => {
  await fixture(async ({ service, dir, projectId, calls, ollama }) => {
    const before = await listing(dir);
    await configure(service, dir, ollama.url);
    expect(await listing(dir)).toEqual(before);

    const smith = fileOf(service, SMITH)!;
    expect(smith.status).toBe("ok");
    const smithWork = service.db.get(smith.work_id);
    expect(smithWork.doi).toBe("10.1000/intero");
    expect(JSON.parse(smith.info).resolution.method).toBe("doi");
    expect(smithWork.raw.counts_by_year).toBeUndefined();
    expect(smithWork.raw.abstractSource).toBe("openalex");

    const kim = fileOf(service, KIM)!;
    expect(kim.status).toBe("ok");
    expect(service.db.get(kim.work_id).doi).toBe("10.2000/dopamine");
    expect(JSON.parse(kim.info).resolution.method).toBe("title");

    // The page-1 DOI is a citation; the title matches but the first author does not.
    const park = fileOf(service, PARK)!;
    expect(park.status).toBe("review");
    expect(JSON.parse(park.info).candidates[0].openalex).toBe("W300");
    expect(service.db.get(park.work_id).doi).toBeNull();

    const lost = fileOf(service, LOST)!;
    expect(lost.status).toBe("provisional");
    expect(service.db.get(lost.work_id).title).toBe("A completely unresolvable gardening manuscript about quantum soil");
    expect(fileOf(service, SUPP)!.status).toBe("auxiliary");
    expect(fileOf(service, "_system/ignored.pdf")).toBeUndefined();

    const copy = fileOf(service, COPY)!;
    expect(JSON.parse(copy.info).duplicateOf).toBe(smith.id);
    expect(copy.work_id).toBe(smith.work_id);
    // Filename records remain only for unresolved files; the copy's record was dropped.
    expect(service.db.db.prepare("SELECT count(*) AS n FROM works WHERE json_extract(data,'$.source')='shelf'").get()).toEqual({ n: 3 });

    const attachments = service.db.attachments(smith.work_id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ mode: "linked", shelfFileId: smith.id, path: join(dir, SMITH), hash: smith.hash });
    expect(await hasValidPdf(service.db, smith.work_id)).toBe(true);
    // Shelf papers are not added to any project.
    expect(service.db.db.prepare("SELECT count(*) AS n FROM project_works").get()).toEqual({ n: 0 });

    const summary = service.shelf.summary();
    const domain = summary.folders.find((f) => f.name === "01 Domain A")!;
    expect(domain.count).toBe(2);
    expect(summary.inbox).toBe(2);
    expect(summary.review).toBe(2);
    expect(summary.counts.embedded).toBe(summary.counts.embeddable);
    expect(summary.counts.embeddable).toBe(4);
    expect(list(service, projectId, "shelf", domain.id).works.map((w) => w.id).sort()).toEqual([smith.work_id, kim.work_id].sort());
    expect(list(service, projectId, "shelf", SHELF_INBOX).total).toBe(2);
    expect(list(service, projectId, "shelf", SHELF_REVIEW).works.map((w) => w.id).sort()).toEqual([park.work_id, lost.work_id].sort());
    const all = list(service, projectId, "shelf", SHELF_ALL);
    expect(all.total).toBe(5);
    expect(all.edges).toContainEqual({ source: smith.work_id, target: kim.work_id });
    const view = all.works.find((w) => w.id === smith.work_id)!;
    expect(view.shelf).toMatchObject({ fileId: smith.id, folder: "01 Domain A/Leaf X", match: "identity", copies: 2 });

    // Second scan with nothing changed calls no API and keeps every row.
    const before2 = { ...calls };
    await service.call("shelfControl", { action: "scan" });
    await service.shelf.wait();
    expect(calls).toEqual(before2);

    // Review: accept the suggested candidate.
    const details = await service.call("shelfResolve", { fileId: park.id, action: "candidate", value: "W300" });
    expect(details.status).toBe("ok");
    expect(service.db.get(park.work_id).doi).toBe("10.3000/hearing");
  });
});

test("rescans follow moves and renames, keep offline shelves intact and confirm mass disappearance", async () => {
  await fixture(async ({ service, dir, ollama, calls }) => {
    await configure(service, dir, ollama.url);
    const smith = fileOf(service, SMITH)!;
    const kim = fileOf(service, KIM)!;
    const embedded = service.db.db.prepare("SELECT count(*) AS n FROM work_embeddings").get();

    await mkdir(join(dir, "03 New"), { recursive: true });
    const moved = "03 New/2023 - Kim, Lee - Dopamine dynamics and memory-guided behavior.pdf";
    await rename(join(dir, KIM), join(dir, moved));
    const renamed = "01 Domain A/Leaf X/smith-renamed.pdf";
    await rename(join(dir, SMITH), join(dir, renamed));
    const callsBefore = { ...calls };
    await service.call("shelfControl", { action: "scan" });
    await service.shelf.wait();
    expect(fileOf(service, moved)).toMatchObject({ id: kim.id, work_id: kim.work_id, status: "ok" });
    expect(fileOf(service, renamed)).toMatchObject({ id: smith.id, work_id: smith.work_id, status: "ok" });
    expect(service.db.attachments(kim.work_id)[0].path).toBe(join(dir, moved));
    expect(calls).toEqual(callsBefore);
    expect(service.db.db.prepare("SELECT count(*) AS n FROM work_embeddings").get()).toEqual(embedded);

    await rm(join(dir, LOST));
    await service.call("shelfControl", { action: "scan" });
    await service.shelf.wait();
    const lost = service.db.db.prepare("SELECT status,work_id FROM shelf_files WHERE rel_path=?").get(LOST) as { status: string; work_id: string };
    expect(lost.status).toBe("missing");
    expect(service.db.get(lost.work_id).title).toContain("quantum soil");

    // An unmounted share never marks files missing.
    await rename(dir, dir + "-offline");
    await service.call("shelfControl", { action: "scan" });
    await service.shelf.wait();
    expect(service.shelf.summary()).toMatchObject({ online: false, job: { state: "offline" } });
    expect(service.db.db.prepare("SELECT count(*) AS n FROM shelf_files WHERE status='missing'").get()).toEqual({ n: 1 });
    await rename(dir + "-offline", dir);

    // Most files gone at once (a half-mounted share): wait for confirmation.
    for (const rel of [moved, renamed, PARK, SUPP]) await rm(join(dir, rel));
    await service.call("shelfControl", { action: "scan" });
    await service.shelf.wait();
    expect(service.shelf.job.state).toBe("confirm");
    expect(service.db.db.prepare("SELECT count(*) AS n FROM shelf_files WHERE status='missing'").get()).toEqual({ n: 1 });
  });
});

test("related papers, hybrid search and lexical fallback when Ollama is off", async () => {
  await fixture(async ({ service, dir, projectId, ollama }) => {
    await configure(service, dir, ollama.url);
    const smith = fileOf(service, SMITH)!, kim = fileOf(service, KIM)!, supp = fileOf(service, SUPP)!;
    const related = await service.call("shelfRelated", { projectId, workId: smith.work_id, limit: 10 });
    expect(related.semantic).toBe(true);
    const ids = related.similar.map((r: { workId: string }) => r.workId);
    expect(ids).not.toContain(smith.work_id);
    expect(ids).not.toContain(supp.work_id);
    expect(related.cites.map((r: { workId: string }) => r.workId)).toEqual([kim.work_id]);
    const elsewhere = await service.call("shelfRelated", { projectId, workId: smith.work_id, limit: 10, otherFoldersOnly: true });
    expect(elsewhere.similar.map((r: { workId: string }) => r.workId)).not.toContain(kim.work_id);
    // A paper without an abstract gets one notice; rows are flagged only for their own basis.
    const setBasis = service.db.db.prepare("UPDATE work_embeddings SET basis=? WHERE work_id=?");
    const basisOf = (id: string) => (service.db.db.prepare("SELECT basis FROM work_embeddings WHERE work_id=?").get(id) as { basis: string }).basis;
    const original = basisOf(smith.work_id);
    setBasis.run("page1", smith.work_id);
    const weak = await service.call("shelfRelated", { projectId, workId: smith.work_id, limit: 10 });
    expect(weak.notice).toContain("PDF 첫 쪽");
    expect(weak.similar.find((r: { workId: string }) => r.workId === kim.work_id)).toMatchObject({ lowConfidence: false });
    for (const r of weak.similar as { workId: string; lowConfidence: boolean }[])
      expect(r.lowConfidence).toBe(["page1", "title"].includes(basisOf(r.workId)));
    setBasis.run(original, smith.work_id);
    setBasis.run("title", kim.work_id);
    const flagged = await service.call("shelfRelated", { projectId, workId: smith.work_id, limit: 10 });
    expect(flagged.notice).toBe("");
    expect(flagged.similar.find((r: { workId: string }) => r.workId === kim.work_id)).toMatchObject({ lowConfidence: true });
    setBasis.run("abstract", kim.work_id);
    // A paper outside the shelf is embedded on the fly and cached.
    const outside = service.db.upsert(structuredClone(OA.external)).work;
    const near = await service.call("shelfRelated", { projectId, workId: outside.id, limit: 3 });
    expect(near.similar[0].workId).toBe(smith.work_id);
    expect((service.db.db.prepare("SELECT count(*) AS n FROM embedding_cache").get() as { n: number }).n).toBeGreaterThan(0);

    const search = await service.call("shelfSearch", { projectId, query: "interoceptive anxiety heartbeat", limit: 10 });
    expect(search.semantic).toBe(true);
    expect(search.hits[0]).toMatchObject({ workId: smith.work_id, lexicalRank: 1, folder: "01 Domain A/Leaf X" });
    expect((await service.call("shelfSearch", { projectId, query: "https://doi.org/10.2000/DOPAMINE", limit: 10 })).hits.map((h: { workId: string }) => h.workId)).toEqual([kim.work_id]);
    // Words that only appear in the abstract are found through FTS.
    expect((await service.call("shelfSearch", { projectId, query: "navigation mice", limit: 10 })).hits[0].workId).toBe(kim.work_id);

    ollama.setUp(false);
    service.shelf["modelKey"] = null;
    const lexical = await service.call("shelfSearch", { projectId, query: "dopamine", limit: 10 });
    expect(lexical.semantic).toBe(false);
    expect(lexical.hits.map((h: { workId: string }) => h.workId)).toEqual([kim.work_id]);
    const offline = await service.call("shelfRelated", { projectId, workId: smith.work_id, limit: 10 });
    expect(offline.semantic).toBe(true); // stored vectors still answer
  });
});

test("the shelf list query is a ranked search scoped to the folder, and filters still apply", async () => {
  await fixture(async ({ service, dir, projectId, ollama }) => {
    await configure(service, dir, ollama.url);
    const smith = fileOf(service, SMITH)!, kim = fileOf(service, KIM)!, park = fileOf(service, PARK)!;
    const search = (query: string, scopeId: string = SHELF_ALL, filters = DEFAULT_FILTERS): Promise<ListResult> =>
      service.call("list", { projectId, scope: "shelf", scopeId, query, filters, showHidden: false, offset: 0, limit: 50, sort: "rank" });

    // The words are not one substring of any record, so the old filter found nothing.
    const found = await search("interoceptive prediction errors anxiety heartbeat");
    expect(found.search).toEqual({ semantic: true, identifier: false });
    expect(found.works[0]).toMatchObject({ id: smith.work_id, evidence: { reasons: ["의미와 검색어 모두 일치"] } });
    expect(found.works.map((w) => w.id)).not.toContain(park.work_id);
    expect(found.total).toBe(found.ids.length);

    // A folder search only looks inside that folder (and its subfolders).
    const domainB = await search("hearing cognitive impairment interoceptive anxiety", park.folder_id);
    expect(domainB.works.map((w) => w.id)).toEqual([park.work_id]);
    const domainA = (service.db.db.prepare("SELECT id FROM shelf_folders WHERE rel_path='01 Domain A'").get() as { id: string }).id;
    expect((await search("dopamine memory navigation", domainA)).works[0].id).toBe(kim.work_id);

    // Filters narrow the ranked hits instead of replacing them.
    const filtered = await search("interoceptive prediction errors anxiety heartbeat", SHELF_ALL, { ...DEFAULT_FILTERS, yearTo: 2023 });
    expect(filtered.works.map((w) => w.id)).not.toContain(smith.work_id);
    expect(filtered.hidden).toBeGreaterThan(0);

    const doi = await search("10.2000/dopamine");
    expect(doi.search).toEqual({ semantic: false, identifier: true });
    expect(doi.works.map((w) => [w.id, w.evidence?.reasons[0]])).toEqual([[kim.work_id, "식별자 일치"]]);

    // Without Ollama only the word index answers, and the list says so.
    ollama.setUp(false);
    service.shelf["modelKey"] = null;
    const lexical = await search("dopamine");
    expect(lexical.search).toEqual({ semantic: false, identifier: false });
    expect(lexical.works.map((w) => [w.id, w.evidence?.reasons[0]])).toEqual([[kim.work_id, "검색어 일치"]]);
    // Function words alone match nothing.
    expect((await search("of the in")).works).toEqual([]);
  });
});

test("searches look in the shelf first, pin shelf hits, badge identity matches and spend no API budget offline", async () => {
  await fixture(async ({ service, dir, projectId, ollama, calls }) => {
    await configure(service, dir, ollama.url);
    const smith = fileOf(service, SMITH)!;
    const run: Run = await service.call("startRun", { projectId, mode: "search", query: "interoception heartbeat anxiety", ids: [], filters: DEFAULT_FILTERS });
    expect(run.tasks[0]).toMatchObject({ kind: "shelf", origin: "내 서고" });
    while (service.discovery.active.size) await Bun.sleep(10);
    const done = service.db.run(run.id);
    expect(done.status).toBe("completed");
    expect(done.calls).toBe(1);
    const result = list(service, projectId, "run", run.id);
    expect(result.shelf!.map((w) => w.id)).toContain(smith.work_id);
    expect(result.works.map((w) => w.id)).not.toContain(smith.work_id);
    const pinned = result.shelf!.find((w) => w.id === smith.work_id)!;
    expect(pinned.evidence!.origins).toEqual(expect.arrayContaining(["내 서고", "키워드 검색"]));
    expect(pinned.evidence!.reasons[0]).toBe("내 서고 · 01 Domain A/Leaf X");
    const external = result.works.find((w) => w.doi === "10.4000/other")!;
    expect(external.shelf).toBeUndefined();
    expect(list(service, projectId, "run", run.id, { ...DEFAULT_FILTERS, shelf: "only" }).total).toBe(0);
    expect(list(service, projectId, "run", run.id, { ...DEFAULT_FILTERS, shelf: "hide" }).total).toBe(1);
    // Shelf results are ordinary review candidates in the project.
    expect(service.db.state(projectId, smith.work_id).screening).toBe("pending");

    const before = { ...calls };
    const offline: Run = await service.call("startRun", { projectId, mode: "search", query: "도파민 dopamine", ids: [], filters: DEFAULT_FILTERS, shelfOnly: true });
    while (service.discovery.active.size) await Bun.sleep(10);
    expect(service.db.run(offline.id)).toMatchObject({ status: "completed", calls: 0 });
    expect(calls).toEqual(before);
    expect(list(service, projectId, "run", offline.id).shelf!.map((w) => w.id)).toEqual([fileOf(service, KIM)!.work_id]);

    const similar: Run = await service.call("startRun", { projectId, mode: "related", query: "", ids: [smith.work_id], filters: DEFAULT_FILTERS, shelfOnly: true });
    while (service.discovery.active.size) await Bun.sleep(10);
    expect(service.db.run(similar.id)).toMatchObject({ status: "completed", calls: 0 });
    expect(list(service, projectId, "run", similar.id).shelf!.length).toBeGreaterThan(0);
    expect(calls).toEqual(before);
  });
});

test("full-text jobs link shelf PDFs instead of downloading; deletion and merges keep shelf records", async () => {
  await fixture(async ({ service, dir, projectId, ollama }) => {
    await configure(service, dir, ollama.url);
    const lost = fileOf(service, LOST)!;
    // A project paper without a DOI whose title matches an unresolved shelf file.
    const paper = service.db.upsert(blankWork({ title: "A completely unresolvable gardening manuscript about quantum soil", year: 2020, citekey: "" })).work;
    service.db.mutate(projectId, [paper.id], { screening: "included" });
    service.downloads["engine"].retrieve = async () => { throw new Error("must not download"); };
    const preview = await service.call("pdfDownloadPreview", { projectId, scope: "archive" });
    expect(preview).toMatchObject({ total: 1, existing: 0, shelf: 1, eligible: 0 });
    const missing = await service.call("missingPdfs", { projectId, scope: "archive" });
    expect(missing.items[0].shelf).toEqual([{ fileId: lost.id, name: LOST, folder: "수신함" }]);
    const run: Run = await service.call("downloadPdfs", { projectId, scope: "archive" });
    while (service.downloads.active.size) await Bun.sleep(10);
    expect(service.db.run(run.id).download!.items[0]).toMatchObject({ status: "completed", message: "서고 PDF 연결 · 다운로드 없음 (수신함)" });
    expect(service.db.attachments(paper.id)[0]).toMatchObject({ shelfFileId: lost.id, mode: "linked", path: join(dir, LOST) });
    expect(await hasValidPdf(service.db, paper.id)).toBe(true);
    // The shelf keeps its own record of the file.
    expect(fileOf(service, LOST)!.work_id).toBe(lost.work_id);

    // Saved, trashed and permanently deleted from a project: the shelf paper stays.
    const smith = fileOf(service, SMITH)!;
    service.db.mutate(projectId, [smith.work_id], { screening: "trash" });
    deleteTrashedWorks(service.db, projectId, [smith.work_id]);
    expect(service.db.get(smith.work_id).doi).toBe("10.1000/intero");
    expect(service.db.attachments(smith.work_id)).toHaveLength(1);

    // Merging moves shelf files, vectors and FTS rows; undo restores them.
    const dup = service.db.upsert(blankWork({ title: "Interoceptive prediction errors in anxiety (preprint)", citekey: "" })).work;
    service.db.mutate(projectId, [dup.id], { screening: "included" });
    mergeWorks(service.db, dup.id, smith.work_id);
    service.shelf.ftsRefresh(dup.id);
    expect(fileOf(service, SMITH)!.work_id).toBe(dup.id);
    expect(service.db.db.prepare("SELECT count(*) AS n FROM work_embeddings WHERE work_id=?").get(dup.id)).toEqual({ n: 1 });
    expect(undoMerge(service.db)).toBe(true);
    service.shelf.ftsRebuild();
    expect(fileOf(service, SMITH)!.work_id).toBe(smith.work_id);
    expect(service.db.db.prepare("SELECT count(*) AS n FROM work_embeddings WHERE work_id=?").get(smith.work_id)).toEqual({ n: 1 });
    expect((await service.call("shelfSearch", { projectId, query: "interoceptive", limit: 5 })).hits[0].workId).toBe(smith.work_id);
  });
});

test("full-text jobs look in the shelf before Chrome, the download folder and the network; an offline shelf refuses the job", async () => {
  await fixture(async ({ service, dir, projectId, ollama, root }) => {
    await configure(service, dir, ollama.url);
    const smith = fileOf(service, SMITH)!, kim = fileOf(service, KIM)!;
    // The shelf's own paper (merged by DOI), one with stop-word and punctuation differences, and two papers it lacks.
    // Runs go in id order, so the variant comes after both downloads.
    const variant = service.db.upsert(blankWork({ id: "z-variant", title: "The Dopamine Dynamics & Memory-Guided Behavior", authors: ["Min Kim"], year: 2023, citekey: "" })).work;
    const stranger = service.db.upsert(blankWork({ id: "0-stranger", title: "Memory-guided behavior and dopamine dynamics", authors: ["Z Nobody"], year: 2023, citekey: "" })).work;
    const absent = service.db.upsert(blankWork({ id: "0-absent", title: "Sleep spindles and overnight memory consolidation", year: 2019, doi: "10.5000/sleep", citekey: "" })).work;
    service.db.mutate(projectId, [smith.work_id, variant.id, stranger.id, absent.id], { screening: "included" });
    // Smith's PDF was also downloaded in Chrome; recovering it would duplicate the shelf file.
    const downloads = join(root, "Downloads");
    await pdf(join(downloads, "smith.pdf"), ["Interoceptive prediction errors in anxiety", "10.1000/intero"]);
    await utimes(join(downloads, "smith.pdf"), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    const tried: string[] = [];
    let linkedBeforeNetwork = false;
    service.downloads["browser"].retrieve = async (work) => {
      if (!tried.length) linkedBeforeNetwork = service.db.attachments(variant.id).length === 1;
      tried.push(work.id);
      throw new AppError("CHROME_TIMEOUT", "no browser in tests");
    };
    service.downloads["engine"].retrieve = async (work) => { tried.push(work.id); throw new AppError("FULLTEXT_UNAVAILABLE", "no network in tests"); };
    // The NAS is unmounted: Smith's linked shelf PDF cannot be verified.
    await rename(dir, `${dir}-unmounted`);
    expect(await hasValidPdf(service.db, smith.work_id)).toBe(false);

    const missing: MissingPdfs = await service.call("missingPdfs", { projectId, scope: "archive" });
    expect(missing).toMatchObject({ total: 4, existing: 0, shelf: 1, eligible: 4 });
    const byId = new Map(missing.items.map((item) => [item.workId, item]));
    expect(byId.get(smith.work_id)).toMatchObject({ status: "missing", message: expect.stringContaining("서고") });
    expect(byId.get(smith.work_id)!.shelf).toBeUndefined();
    expect(byId.get(variant.id)!.shelf).toEqual([{ fileId: kim.id, name: basename(KIM), folder: "01 Domain A/Leaf Y" }]);
    expect(byId.get(stranger.id)!.shelf).toBeUndefined();

    // Downloads are stored in the shelf inbox, so no job starts while the shelf is offline.
    const request = { projectId, scope: "archive", useBrowser: true, downloadDirectory: downloads };
    await expect(service.call("downloadPdfs", request)).rejects.toMatchObject({ code: "SHELF_OFFLINE" });
    expect(tried).toEqual([]);
    expect(service.db.attachments(variant.id)).toEqual([]);

    await rename(`${dir}-unmounted`, dir);
    expect(await hasValidPdf(service.db, smith.work_id)).toBe(true);
    const run: Run = await service.call("downloadPdfs", request);
    while (service.downloads.active.size) await Bun.sleep(10);
    const items = new Map(service.db.run(run.id).download!.items.map((item) => [item.workId, item]));
    expect(tried.sort()).toEqual([absent.id, absent.id, stranger.id, stranger.id].sort());
    expect(linkedBeforeNetwork).toBe(true);
    expect(items.get(smith.work_id)).toMatchObject({ status: "existing" });
    expect(items.get(variant.id)).toMatchObject({ status: "completed", message: "서고 PDF 연결 · 다운로드 없음 (01 Domain A/Leaf Y)" });
    expect(service.db.attachments(smith.work_id).map((a) => a.mode)).toEqual(["linked"]);
    expect(service.db.attachments(variant.id)).toEqual([expect.objectContaining({ mode: "linked", shelfFileId: kim.id })]);
    expect(await readdir(join(service.db.root, "attachments")).catch(() => [])).toEqual([]);

    // Background recovery of Chrome downloads leaves shelf papers alone, also while the NAS is away.
    const failed = service.db.run(run.id);
    failed.download!.items.find((item) => item.workId === smith.work_id)!.status = "failed";
    service.db.saveRun(failed);
    await rename(dir, `${dir}-unmounted`);
    await service.downloads.recoverCompleted();
    expect(service.db.attachments(smith.work_id)).toHaveLength(1);
    expect(await stat(join(downloads, "smith.pdf")).then(() => true)).toBe(true);
    await rename(`${dir}-unmounted`, dir);
    await service.downloads.syncHistory();
    expect(service.db.run(run.id).download!.items.find((item) => item.workId === smith.work_id)).toMatchObject({ status: "completed" });
    expect(await hasValidPdf(service.db, variant.id)).toBe(true);
  });
});

test("shelf papers open in the reader without project membership and lead AI evidence", async () => {
  await fixture(async ({ service, dir, projectId, ollama }) => {
    await configure(service, dir, ollama.url);
    const smith = fileOf(service, SMITH)!;
    const info = await service.call("pdfInfo", { projectId, workId: smith.work_id, attachmentId: smith.attachment_id });
    expect(info.hash).toBe(smith.hash);
    service.externalEvidence = async () => ({ sources: [{ title: "Duplicate", url: "https://doi.org/10.1000/intero", content: "x", doi: "10.1000/intero" }, { title: "Web", url: "https://example.org/a", content: "y" }], notice: "" });
    const evidence = await service.evidence("interoceptive anxiety", {}, new AbortController().signal);
    expect(evidence.sources[0]).toMatchObject({ source: "shelf", workId: smith.work_id });
    expect(evidence.sources[0].url).toBeUndefined();
    expect(evidence.sources.map((s) => s.title)).not.toContain("Duplicate");
    expect(evidence.sources.at(-1)!.title).toBe("Web");
  });
});

test("schema 2 libraries upgrade to schema 3 in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-shelf-schema-"));
  try {
    const first = new Library(root);
    first.db.exec("DROP TABLE shelf_files; DROP TABLE shelf_folders; DROP TABLE shelf_roots; DROP TABLE work_embeddings; DROP TABLE embedding_cache; DROP TABLE shelf_fts; PRAGMA user_version=2;");
    first.close();
    const second = new Library(root);
    expect(second.db.pragma("user_version", { simple: true })).toBe(3);
    expect(second.db.prepare("SELECT count(*) AS n FROM shelf_files").get()).toEqual({ n: 0 });
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shelf lookups keep an OpenAlex reserve, keep paid results and resume after restarts at the reported reset", async () => {
  await fixture(async ({ service, dir, ollama, calls, root }) => {
    const page = service.oa.page.bind(service.oa);
    service.oa.page = async (params, signal, onCall) => {
      const result = await page(params, signal, onCall);
      // After the first (DOI batch) call the daily balance is under the 20% reserve.
      service.oa.rateLimit = { limit: 1000, remaining: 150, resetAt: Date.now() + 3_600_000 };
      return result;
    };
    await configure(service, dir, ollama.url);
    expect(calls).toMatchObject({ doi: 1, search: 0 });
    expect(fileOf(service, SMITH)!.status).toBe("ok");
    expect(fileOf(service, KIM)).toMatchObject({ stage: "extracted", status: "provisional" });
    const until = Date.parse(service.shelf.job.resolverPausedUntil!);
    expect(until).toBeGreaterThan(Date.now() + 60 * 60_000);
    expect(service.shelf.job.message).toContain("검색용으로 남김");
    // Hashing, extraction, browsing and embeddings continue without OpenAlex.
    const counts = service.shelf.summary().counts;
    expect(counts.embedded).toBe(counts.embeddable);

    // A 429 reports the seconds until the UTC reset; the client carries them to the indexer.
    const { OpenAlex } = await import("../../src/service/providers/openalex");
    const limited = new OpenAlex(service.db, () => undefined, async () =>
      new Response("{}", { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "10000", "x-ratelimit-reset": "32400" } }));
    const error = await limited.page({ search: "unique budget probe" }, new AbortController().signal, () => {}).catch((e) => e);
    expect(error).toMatchObject({ code: "DAILY_BUDGET", resetMs: 32_400_000 });
    expect(limited.rateLimit).toMatchObject({ limit: 10000, remaining: 0 });
    // A balance below the request's cost is the daily budget too, not a 60-second window.
    const short = new OpenAlex(service.db, () => undefined, async () =>
      new Response("{}", { status: 429, headers: { "x-ratelimit-remaining": "3", "x-ratelimit-credits-required": "10", "x-ratelimit-limit": "10000", "x-ratelimit-reset": "600" } }));
    expect(await short.page({ search: "another probe" }, new AbortController().signal, () => {}).catch((e) => e)).toMatchObject({ code: "DAILY_BUDGET", resetMs: 600_000 });

    // Waiting files are not "needs review"; only finished lookups without verified metadata are.
    expect(service.shelf.summary().review).toBe(0);
    expect(service.shelf.summary().counts.stages.extracted).toBe(3);
    expect(service.shelf.summary().counts.statuses.provisional).toBe(0);

    // Restart: the saved pause is honoured without spending a request, then resumes where it stopped.
    const restarted = new Service(join(root, "library"), worker, () => {});
    let spent = 0;
    restarted.oa.page = async (params, signal, onCall) => { spent++; return service.oa.page(params, signal, onCall); };
    try {
      expect(restarted.shelf.job.message).toContain("검색용으로 남김");
      await restarted.shelf.scan("startup");
      expect(spent).toBe(0);
      expect(fileOf(restarted, KIM)!.stage).toBe("extracted");
      service.oa.rateLimit = null;
      service.oa.page = page;
      restarted.shelf.command("resume");
      await restarted.shelf.wait();
      expect(spent).toBeGreaterThan(0);
      expect(fileOf(restarted, KIM)).toMatchObject({ stage: "resolved", status: "ok" });
      expect(restarted.db.pref("shelf:resolverPause")).toBeUndefined();
    } finally {
      restarted.shelf.stop();
      await restarted.shelf.wait();
      restarted.downloads.stopRecoveryMonitor();
      restarted.db.close();
    }
  });
});
