import { resultWindow } from "../../src/shared/graph";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Library } from "../../src/service/db/database";
import {
  blankWork,
  normalizeDoi,
  restoreAbstract,
  relatedness,
  filterReasons,
  similarityEdges,
} from "../../src/shared/domain";
import { DEFAULT_FILTERS, defaultState } from "../../src/shared/types";
import { parseBib, exportBib } from "../../src/service/interchange/bibtex";
import {
  createBackup,
  restoreBackup,
} from "../../src/service/interchange/backup";
import { hashFile, PdfImports } from "../../src/service/interchange/pdf";
import { Discovery } from "../../src/service/discovery/engine";
import { OpenAlex, fromOpenAlex } from "../../src/service/providers/openalex";
import { validateRecommendations } from "../../src/service/providers/openai";
import { mergeWorks, undoMerge } from "../../src/service/db/merge";
import { schemas } from "../../src/shared/contracts";

async function fixture<T>(fn: (db: Library, root: string) => Promise<T> | T) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-test-"));
  const db = new Library(join(root, "library"));
  try {
    return await fn(db, root);
  } finally {
    try {
      db.close();
    } catch {
      /* Already closed in restart test. */
    }
    await rm(root, { recursive: true, force: true });
  }
}
function raw(
  n: number,
  title: string,
  refs: number[] = [],
  abstract = "interoception social cognition",
) {
  return {
    id: `https://openalex.org/W${n}`,
    doi: `https://doi.org/10.9999/${n}`,
    title,
    publication_year: 2020,
    type: "article",
    cited_by_count: n === 8 ? 100000 : 2,
    authorships: [{ author: { display_name: "Lee, A" } }],
    referenced_works: refs.map((n) => `https://openalex.org/W${n}`),
    related_works: [],
    topics: [],
    abstract_inverted_index: Object.fromEntries(
      abstract.split(" ").map((w, i) => [w, [i]]),
    ),
  };
}
const graph = [
  raw(1, "Interoception and social cognition A", [3, 4, 5]),
  raw(2, "Interoception and social cognition B", [3, 4, 6]),
  raw(3, "Interoception foundation"),
  raw(4, "Social cognition foundation"),
  raw(5, "Interoception branch A"),
  raw(6, "Interoception branch B"),
  raw(7, "Interoception joint followup", [1, 2]),
  raw(
    8,
    "High energy particle collider statistics",
    [1],
    "hadron collision detectors",
  ),
  raw(9, "Interoception new study", [1, 3]),
  raw(10, "Interoception another joint followup", [1, 2, 3]),
];
const mockFetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (input) => {
  const u = new URL(String(input));
  if (u.pathname.startsWith("/works/")) {
    const id = decodeURIComponent(u.pathname.slice(7));
    const work = graph.find(
      (w) => w.id.endsWith("/" + id) || w.doi.endsWith(id),
    );
    return new Response(JSON.stringify(work || {}), {
      status: work ? 200 : 404,
    });
  }
  let results = graph;
  if (u.searchParams.get("filter")?.startsWith("openalex:")) {
    const ids = u.searchParams.get("filter")!.slice(9).split("|");
    results = graph.filter((w) => ids.some((id) => w.id.endsWith("/" + id)));
  } else if (u.searchParams.get("filter")?.startsWith("cites:")) {
    const id = u.searchParams.get("filter")!.slice(6);
    results = graph.filter((w) =>
      w.referenced_works.some((ref) => ref.endsWith("/" + id)),
    );
  }
  return new Response(
    JSON.stringify({
      results,
      meta: { count: results.length, next_cursor: null },
    }),
  );
};
async function finished(db: Library, id: string) {
  for (let i = 0; i < 6000; i++) {
    const r = db.run(id);
    if (!["queued", "running"].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Job timed out");
}

test("DOI normalization and sparse abstracts distinguish null from known empty", () => {
  assert.equal(normalizeDoi(" HTTPS://doi.org/10.1234/AbCd "), "10.1234/abcd");
  assert.equal(normalizeDoi("not-a-doi"), null);
  assert.equal(restoreAbstract({ world: [1], hello: [0] }), "hello world");
  assert.equal(restoreAbstract(null), null);
  assert.equal(restoreAbstract({ a: [0], b: [0] }), null);
  assert.equal(
    fromOpenAlex({
      ...raw(1, "X"),
      referenced_works: null,
      cited_by_count: null,
    }).references,
    null,
  );
});
test("identity deduplication, citekey stability, user overrides and project isolation", () =>
  fixture((db) => {
    const p = db.projects()[0].id,
      p2 = db.createProject("Second", "").id;
    const a = db.upsert(
      blankWork({
        doi: "https://doi.org/10.1000/ABC",
        title: "Interoception in social cognition",
        authors: ["Kim, A"],
      }),
    ).work;
    db.mutate(p, [a.id], { screening: "included", note: "Keep me" });
    db.edit(a.id, { title: "My corrected title" });
    const b = db.upsert(
      blankWork({
        doi: "10.1000/abc",
        title: "Interoception in social cognition",
      }),
    );
    assert.equal(b.work.id, a.id);
    assert.equal(b.work.title, "My corrected title");
    assert.equal(b.work.citekey, a.citekey);
    assert.equal(db.state(p, a.id).note, "Keep me");
    assert.equal(db.state(p2, a.id).note, "");
    assert.throws(() =>
      db.upsert(
        blankWork({
          doi: "10.1000/abc",
          title: "Completely different astrophysics manuscript",
        }),
      ),
    );
  }));
test("120 BibTeX entries round trip with macros, corporate authors, Unicode, custom fields and subset export", () =>
  fixture((db) => {
    const bib =
      "@string{j={Journal of {DNA}}}\n" +
      Array.from(
        { length: 120 },
        (_, i) =>
          `@article{key${i},title={Neural {DNA} 연구 ${i}},author={{World Health Organization} and García, María},journal=j,year={2024},doi={10.8888/test${i}},custom={preserve ${i}},file={/Users/private/paper.pdf},note={private}}`,
      ).join("\n");
    const entries = parseBib(bib);
    assert.equal(entries.length, 120);
    assert(entries.every((e) => !!e.work));
    const works = entries.map((e) => db.upsert(e.work!).work);
    assert.deepEqual(works[0].authors, [
      "World Health Organization",
      "García, María",
    ]);
    const out = exportBib(works);
    assert(!out.text.includes("/Users/"));
    assert(!out.text.includes("private"));
    assert(out.text.includes("custom = {preserve 0}"));
    const again = parseBib(out.text);
    assert.equal(again.length, 120);
    for (const e of again) {
      assert(e.work, e.error || "missing parsed work");
      db.upsert(e.work!);
    }
    assert.equal(
      (db.db.prepare("SELECT count(*) AS n FROM works").get() as { n: number })
        .n,
      120,
    );
    assert.deepEqual(again[0].work!.authors, works[0].authors);
    assert.equal(again[0].work!.title, works[0].title);
    const subset = parseBib(exportBib([works[7], works[11], works[7]]).text);
    assert.equal(subset.length, 2);
    assert.deepEqual(
      subset.map((e) => e.work!.citekey),
      ["key7", "key11"],
    );
  }));
test("BibTeX parser recovers good entries and resolves crossref subset fields", () => {
  const parsed = parseBib(
    "@book{p,title={Book},year={2020},publisher={Press}}\n@incollection{c,title={Chapter},author={Smith, Alice},crossref={p}}\n@article{bad, title=\n@article{good,title={Good},year={2022}}",
  );
  assert(parsed.some((e) => e.error));
  assert(parsed.some((e) => e.work?.citekey === "good"));
  const child = parsed.find((e) => e.work?.citekey === "c")!.work!;
  assert.equal(child.year, 2020);
  const subset = exportBib([child]).text;
  assert(!subset.includes("crossref"));
  assert(subset.includes("Press"));
});
test("library undo, trash restoration, collection membership and merge undo preserve notes", () =>
  fixture((db) => {
    const p = db.projects()[0].id;
    const a = db.upsert(
      blankWork({ title: "Same scientific article", authors: ["Lee, B"] }),
    ).work;
    const b = db.upsert(
      blankWork({ title: "Same scientific article", authors: ["Lee, B"] }),
    ).work;
    db.mutate(p, [a.id], { note: "A note", screening: "included" });
    db.mutate(p, [b.id], { note: "B note" });
    db.mutate(p, [a.id], { screening: "trash" });
    assert.equal(db.state(p, a.id).previousScreening, "included");
    assert(db.undo(p));
    assert.equal(db.state(p, a.id).screening, "included");
    mergeWorks(db, a.id, b.id);
    assert(db.state(p, a.id).note.includes("B note"));
    assert.throws(() => db.get(b.id));
    assert(undoMerge(db));
    assert.equal(db.state(p, a.id).note, "A note");
    assert.equal(db.state(p, b.id).note, "B note");
    assert.equal((db.db.pragma("foreign_key_check") as unknown[]).length, 0);
  }));
test("exact citation directions and common reference/citing counts retain the frozen initial seeds", () =>
  fixture(async (db) => {
    const p = db.projects()[0].id;
    const seeds = graph.slice(0, 2).map((r) => db.upsert(fromOpenAlex(r)).work);
    db.setSeeds(
      p,
      seeds.map((w) => w.id),
      "interoception social cognition",
      {},
    );
    const d = new Discovery(
      db,
      new OpenAlex(db, () => undefined, mockFetch),
      () => {},
    );
    const r = d.start({
      projectId: p,
      mode: "commonReferences",
      query: "",
      ids: seeds.map((w) => w.id),
      filters: { ...DEFAULT_FILTERS },
    });
    assert.equal((await finished(db, r.id)).status, "completed");
    const c = db.candidates(r.id);
    assert.equal(
      c.find((e) => e.work.openalex === "W3")!.evidence.seedIds.length,
      2,
    );
    assert.equal(
      c.find((e) => e.work.openalex === "W5")!.evidence.seedIds.length,
      1,
    );
    const ids = [...seeds.map((w) => w.id), ...c.map((e) => e.work.id)];
    const edges = db.edges(ids);
    const w3 = c.find((e) => e.work.openalex === "W3")!.work;
    assert(edges.some((e) => e.source === seeds[0].id && e.target === w3.id));
    assert(!edges.some((e) => e.source === w3.id && e.target === seeds[0].id));
    db.upsert({ ...w3, references: [...(w3.references || []), w3.openalex!] });
    assert(db.edges(ids).every((e) => e.source !== e.target));
    const similar = similarityEdges([
      { ...seeds[0], related: [w3.openalex!, seeds[0].openalex!] },
      { ...w3, related: [seeds[0].openalex!] },
    ]);
    assert.equal(similar.length, 1);
    assert.deepEqual(
      new Set([similar[0].source, similar[0].target]),
      new Set([seeds[0].id, w3.id]),
    );
    const r2 = d.start({
      projectId: p,
      mode: "commonCiting",
      query: "",
      ids: seeds.map((w) => w.id),
      filters: { ...DEFAULT_FILTERS },
    });
    await finished(db, r2.id);
    assert.equal(
      db.candidates(r2.id).find((e) => e.work.openalex === "W7")!.evidence
        .seedIds.length,
      2,
    );
    assert.deepEqual(
      db.seedHistory(p)[0].ids,
      seeds.map((w) => w.id),
    );
  }));
test("high citations cannot bypass relevance, and missing abstracts remain deferred", () => {
  const anchor = fromOpenAlex(graph[0]),
    bad = fromOpenAlex(graph[7]),
    recent = fromOpenAlex({ ...graph[8], cited_by_count: 0 }),
    missing = fromOpenAlex({ ...graph[3], abstract_inverted_index: null });
  const scores = relatedness(
    [bad, recent, missing],
    [anchor],
    "interoception social cognition",
  );
  for (const work of [bad, recent]) {
    const c = scores.get(work.id)!;
    const evidence = {
      origins: [],
      seedIds: [],
      sharedIds: [],
      denominator: 1,
      relation: "related",
      score: c.score,
      reasons: [],
      hidden: [],
      deferred: c.deferred,
      scope: "fixture",
    };
    const reasons = filterReasons(
      { ...work, state: defaultState(), attachmentCount: 0, collectionIds: [] },
      { ...DEFAULT_FILTERS, relevance: true, strictness: "strict" },
      evidence,
    );
    assert.equal(
      reasons.includes("초기 관심과 낮은 관련성"),
      work.id === bad.id,
    );
  }
  assert.equal(restoreAbstract(null), null);
});
test("interrupted jobs reopen as resumable; cancellation retains existing library", () =>
  fixture(async (db, root) => {
    const p = db.projects()[0].id;
    const w = db.upsert(fromOpenAlex(graph[0])).work;
    db.mutate(p, [w.id], { note: "persisted note", screening: "included" });
    const delayed: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (_u, options) =>
      new Promise((_res, reject) =>
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("abort")),
        ),
      );
    const d = new Discovery(
      db,
      new OpenAlex(db, () => undefined, delayed),
      () => {},
    );
    const r = d.start({
      projectId: p,
      mode: "search",
      query: "cancel",
      ids: [],
      filters: { ...DEFAULT_FILTERS },
    });
    d.control(r.id, "cancel");
    assert.equal((await finished(db, r.id)).status, "cancelled");
    await new Promise((r) => setTimeout(r, 30));
    const interrupted = { ...db.run(r.id), status: "running" as const };
    db.saveRun(interrupted);
    db.close();
    const reopened = new Library(join(root, "library"));
    try {
      assert.equal(reopened.run(r.id).status, "interrupted");
      assert.equal(reopened.state(p, w.id).note, "persisted note");
    } finally {
      reopened.close();
    }
  }));
test("OpenAlex budgets/429 are surfaced without zero-filled metadata and secrets are headers only", () =>
  fixture(async (db) => {
    let calls = 0;
    const fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (url, options) => {
      assert(!String(url).includes("secret"));
      assert.equal((options?.headers as any).Authorization, "Bearer secret");
      return new Response("{}", {
        status: 429,
        headers: { "x-ratelimit-remaining": "0" },
      });
    };
    const oa = new OpenAlex(db, () => "secret", fetcher);
    await assert.rejects(
      oa.page({}, new AbortController().signal, () => calls++),
      /일일 예산/,
    );
    assert.equal(calls, 1);
  }));
test("AI rejects invented IDs, unavailable quotations, injected numbers and duplicate IDs", () => {
  const w = blankWork({
    title: "Interoception study",
    abstract: "A study of interoception and social cognition.",
  });
  const good = {
    id: w.id,
    role: "직접 관련 연구",
    reason: "사회인지와 관련된 연구입니다.",
    quote: "interoception and social cognition",
    limitation: "초록 기반",
    evidenceIds: [w.id],
  };
  assert.equal(
    validateRecommendations({ recommendations: [good] }, [w]).recommendations
      .length,
    1,
  );
  for (const bad of [
    { ...good, id: "invented" },
    { ...good, quote: "unavailable quote" },
    { ...good, reason: "효과 크기는 89.1입니다." },
    { ...good, evidenceIds: ["invented"] },
  ])
    assert.throws(() =>
      validateRecommendations({ recommendations: [bad] }, [w]),
    );
  assert.throws(() =>
    validateRecommendations({ recommendations: [good, good] }, [w]),
  );
});
export function minimalPdf(title = "Local research fixture"): Buffer {
  const content = `BT /F1 18 Tf 70 700 Td (${title}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}
test("PDF worker imports twice without duplication and preserves the original bytes", () =>
  fixture(async (db, root) => {
    const source = join(root, "source.pdf");
    await writeFile(source, minimalPdf());
    const before = await hashFile(source);
    const importer = new PdfImports(
      db,
      new OpenAlex(db, () => undefined, mockFetch),
      resolve("dist/pdf-worker.cjs"),
      () => {},
    );
    const projectId = db.projects()[0].id;
    const r = await importer.start(projectId, [source], { mode: "managed" });
    assert.equal((await finished(db, r.id)).count, 1);
    const candidates = db.candidates(r.id);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].work.title, "Local research fixture");
    const a = db.attachments(candidates[0].work.id)[0];
    assert.equal(await hashFile(a.path), before);
    assert.equal(await hashFile(source), before);
    const r2 = await importer.start(projectId, [source], { mode: "managed" });
    await finished(db, r2.id);
    assert.equal(db.candidates(r2.id)[0].work.id, candidates[0].work.id);
    assert.equal(db.attachments(candidates[0].work.id).length, 1);
  }));
test("SQLite online backup and attachment restore are verified, and corrupt manifests never switch libraries", () =>
  fixture(async (db, root) => {
    const p = db.projects()[0].id;
    const w = db.upsert(blankWork({ title: "Backup science" })).work;
    db.mutate(p, [w.id], {
      note: "Preserve this note",
      tags: ["tag"],
      screening: "included",
    });
    const file = join(root, "source.pdf");
    await writeFile(file, minimalPdf());
    const hash = await hashFile(file);
    db.saveAttachment({
      id: "attachment",
      workId: w.id,
      name: "source.pdf",
      path: file,
      hash,
      mode: "linked",
      size: (await readFile(file)).length,
      status: "ok",
      exists: true,
    });
    const target = join(root, "backup");
    assert.deepEqual((await createBackup(db, target, true, true)).missing, []);
    const restored = await restoreBackup(target, join(root, "restored"));
    const check = new Library(restored.path);
    try {
      assert.equal(check.state(p, w.id).note, "Preserve this note");
      assert.equal(await hashFile(check.attachments(w.id)[0].path), hash);
    } finally {
      check.close();
    }
    const manifest = JSON.parse(
      await readFile(join(target, "manifest.json"), "utf8"),
    );
    manifest.attachments[0].file = "../../outside.pdf";
    await writeFile(join(target, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(restoreBackup(target, join(root, "bad")));
    assert.equal(db.state(p, w.id).note, "Preserve this note");
  }));
test("IPC contracts reject raw SQL, excessive payloads and malformed fields", () => {
  assert(!Object.hasOwn(schemas, "sql"));
  assert.throws(() =>
    schemas.editWork.parse({
      workId: "x",
      patch: { title: "ok", secret: "bad" },
    }),
  );
  assert.throws(() =>
    schemas.list.parse({
      projectId: "x",
      scope: "archive",
      filters: { ...DEFAULT_FILTERS, minCitations: -1 },
    }),
  );
  assert.throws(() =>
    schemas.startRun.parse({
      projectId: "x",
      mode: "deleteAll",
      query: "",
      ids: [],
      filters: DEFAULT_FILTERS,
    }),
  );
});

test("candidate budget checkpoints retain the unprocessed part of an API page", () =>
  fixture(async (db) => {
    const projectId = db.projects()[0].id;
    let calls = 0;
    const counted: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (...args) => {
      calls++;
      return mockFetch(...args);
    };
    const d = new Discovery(
      db,
      new OpenAlex(db, () => undefined, counted),
      () => {},
    );
    const id = crypto.randomUUID();
    const run = {
      id,
      projectId,
      mode: "search" as const,
      query: "fixture",
      seedProfileId: null,
      inputIds: [],
      filters: { ...DEFAULT_FILTERS },
      status: "queued" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      calls: 0,
      maxCalls: 40,
      maxCandidates: 1,
      total: null,
      count: 0,
      message: "",
      tasks: [
        {
          kind: "search" as const,
          query: "fixture",
          origin: "키워드 검색",
          cursor: "*",
        },
      ],
      rankingVersion: "test",
      phase: "collect",
    };
    db.saveRun(run);
    await d.execute(id);
    assert.equal(db.run(id).status, "paused_budget");
    assert.equal(db.run(id).count, 1);
    assert.equal(db.run(id).tasks[0].pendingPage?.works.length, 9);
    d.control(id, "resume");
    await finished(db, id);
    assert.equal(db.run(id).count, 10);
    assert.equal(calls, 1);
    assert.equal(db.candidates(id).length, 10);
  }));

test("100-file PDF batch preserves all originals and records every result", () =>
  fixture(async (db, root) => {
    const paths: string[] = [];
    for (let i = 0; i < 100; i++) {
      const path = join(root, `source-${i}.pdf`);
      await writeFile(path, minimalPdf(`Synthetic local fixture ${i}`));
      paths.push(path);
    }
    const before = await Promise.all(paths.map((p) => hashFile(p)));
    const importer = new PdfImports(
      db,
      new OpenAlex(db, () => undefined, mockFetch),
      resolve("dist/pdf-worker.cjs"),
      () => {},
    );
    const run = await importer.start(db.projects()[0].id, paths, {
      mode: "linked",
    });
    assert.equal((await finished(db, run.id)).count, 100);
    assert.equal(db.candidates(run.id).length, 100);
    assert.deepEqual(await Promise.all(paths.map((p) => hashFile(p))), before);
  }));

test("backtracking preserves selections, view state, branches and restart state", async () => {
  const {
    defaultView,
    restoreNavigation,
    visitView,
    moveHistory,
    rememberView,
  } = await import("../../src/shared/navigation");
  const root = defaultView({
    scope: "run",
    scopeId: "search",
    selected: ["a", "b", "c"],
    query: "question",
    localQuery: "topic",
    view: "timeline",
    sort: "year",
    inspectorId: "b",
    networkPositions: { a: { x: 3, y: 7 } },
  });
  const related = defaultView({
    scope: "run",
    scopeId: "related",
    selected: ["d"],
  });
  let history = visitView(restoreNavigation(root), root, related);
  root.selected.push("mutation-after-navigation");
  history = moveHistory(history, related, -1);
  const restored = history.views[history.keys[history.index]];
  assert.deepEqual(restored.selected, ["a", "b", "c"]);
  assert.equal(restored.view, "timeline");
  assert.equal(restored.localQuery, "topic");
  assert.deepEqual(restored.networkPositions, { a: { x: 3, y: 7 } });
  const forward = moveHistory(history, restored, 1);
  assert.deepEqual(forward.views[forward.keys[forward.index]].selected, ["d"]);
  const cited = defaultView({ scope: "run", scopeId: "cited" });
  history = visitView(history, restored, cited);
  assert.deepEqual(history.keys, ["run:search", "run:cited"]);
  assert.deepEqual(history.views["run:related"].selected, ["d"]);
  assert.deepEqual(
    restoreNavigation(
      JSON.parse(JSON.stringify({ navigation: rememberView(history, cited) })),
    ),
    history,
  );
  assert.equal(
    restoreNavigation({
      navigation: { keys: ["missing"], index: 7, views: {} },
    }).views["archive:"].scope,
    "archive",
  );
});

test("long navigation histories keep the current stage and bound preference storage", async () => {
  const { defaultView, restoreNavigation, visitView, compactNavigation } =
    await import("../../src/shared/navigation");
  let current = defaultView();
  let history = restoreNavigation(current);
  for (let i = 0; i < 90; i++) {
    const next = defaultView({
      scope: "run",
      scopeId: String(i),
      selected: [String(i)],
      networkPositions: Object.fromEntries(
        Array.from({ length: 500 }, (_, n) => [String(n), { x: n, y: n }]),
      ),
    });
    history = visitView(history, current, next);
    current = next;
  }
  history = compactNavigation(history);
  assert.equal(history.keys[history.index], "run:89");
  assert.deepEqual(history.views["run:89"].selected, ["89"]);
  assert(Object.keys(history.views).length <= 40);
  assert(JSON.stringify(history).length <= 850000);
  assert(history.keys.every((key) => history.views[key]));
});

test("exploration roots and branches stay inside their project", () =>
  fixture(async (db) => {
    const { runPath } = await import("../../src/shared/navigation");
    const p = db.projects()[0].id;
    const d = new Discovery(
      db,
      new OpenAlex(db, () => undefined, mockFetch),
      () => {},
    );
    const search = d.start({
      projectId: p,
      mode: "search",
      query: "interoception",
      ids: [],
      filters: DEFAULT_FILTERS,
      parentId: "obsolete",
    });
    await finished(db, search.id);
    assert.equal(search.parentId, undefined);
    const ids = db
      .candidates(search.id)
      .slice(0, 3)
      .map((c) => c.work.id);
    const related = d.start({
      projectId: p,
      mode: "related",
      query: "interoception",
      ids,
      filters: DEFAULT_FILTERS,
      parentId: search.id,
    });
    await finished(db, related.id);
    const cited = d.start({
      projectId: p,
      mode: "citedBy",
      query: "interoception",
      ids,
      filters: DEFAULT_FILTERS,
      parentId: search.id,
    });
    await finished(db, cited.id);
    assert.deepEqual(
      runPath(db.runs(p), cited.id).map((r) => r.id),
      [search.id, cited.id],
    );
    assert.deepEqual(related.inputIds, cited.inputIds);
    const second = db.createProject("Separate", "").id;
    assert.throws(
      () =>
        d.start({
          projectId: second,
          mode: "citedBy",
          query: "",
          ids,
          filters: DEFAULT_FILTERS,
          parentId: search.id,
        }),
      /다른 프로젝트/,
    );
  }));

test("reading filters apply before pagination and preserve the archived inventory", () =>
  fixture((db) => {
    const projectId = db.projects()[0].id;
    const works = [1, 2, 3, 4].map(
      (n) => db.upsert(fromOpenAlex(raw(n, `Reading fixture ${n}`))).work,
    );
    db.mutate(
      projectId,
      works.map((w) => w.id),
      { screening: "included" },
    );
    db.mutate(projectId, [works[0].id, works[2].id], { reading: "reading" });
    db.mutate(projectId, [works[1].id], { reading: "read" });
    const args = {
      projectId,
      scope: "archive",
      query: "",
      filters: { ...DEFAULT_FILTERS, reading: "reading" as const },
      showHidden: false,
      offset: 0,
      limit: 1,
      sort: "title",
    };
    const first = db.list(args);
    const second = db.list({ ...args, offset: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.hidden, 2);
    assert.equal(first.works[0].id, works[0].id);
    assert.equal(second.works[0].id, works[2].id);
    assert.equal(
      db.list({ ...args, filters: DEFAULT_FILTERS, limit: 50 }).total,
      4,
    );
    assert.equal(schemas.list.parse(args).filters.reading, "reading");
    assert.equal(
      schemas.list.parse({ ...args, filters: DEFAULT_FILTERS }).filters.reading,
      undefined,
    );
  }));


test("archive graph loads all 76 papers and their edges without pending papers", () => fixture((db) => {
  const projectId = db.projects()[0].id;
  const papers = Array.from({ length: 76 }, (_, n) => db.upsert(fromOpenAlex(raw(n + 500, `Graph archive ${n}`))).work);
  db.mutate(projectId, papers.map((work) => work.id), { screening: "included" });
  const pending = db.upsert(fromOpenAlex(raw(999, "Pending should not appear"))).work;
  db.ensureMembership(projectId, pending.id);
  db.db.prepare("INSERT OR IGNORE INTO citations VALUES(?,?)").run(papers[75].id, papers[0].openalex);
  const args = { projectId, scope: "archive", query: "", filters: DEFAULT_FILTERS, showHidden: false, sort: "rank", ...resultWindow(true, 50, 50) };
  const graph = db.list(args);
  assert.equal(graph.total, 76);
  assert.equal(graph.works.length, 76);
  assert.equal(graph.context?.length, 0);
  assert(graph.works.every((work) => work.state.screening === "included"));
  assert(!graph.ids.includes(pending.id));
  assert(graph.edges.some((edge) => edge.source === papers[75].id && edge.target === papers[0].id));
  assert.equal(db.list({ ...args, ...resultWindow(false, 50, 0) }).works.length, 50);
}));
