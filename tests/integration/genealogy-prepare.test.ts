import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { genealogyFixture, settle, type Fixture } from "./genealogy-helpers";
import { jatsText, partOf, pdfText, readingText } from "../../src/service/genealogy/sections";
import { pmcidOf, typeFromMetadata } from "../../src/service/genealogy/sources";
import { blankWork } from "../../src/shared/domain";
import { mergeWorks } from "../../src/service/db/merge";
import type { Page } from "../../src/service/providers/openalex";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await genealogyFixture();
  fixtures.push(f);
  return f;
}

const JATS = `<?xml version="1.0"?><!DOCTYPE article PUBLIC "-//NLM//DTD JATS" "x.dtd"><article><front><article-meta><abstract><title>Abstract</title><p>Short abstract &amp; aims.</p></abstract></article-meta></front>
<body><sec sec-type="intro"><title>Introduction</title><p>Origins of the entropic brain idea${" with context".repeat(120)}.</p></sec>
<sec><title>Methods</title><p>Scanner details.</p><table-wrap><table><tr><td>TABLE_SECRET</td></tr></table></table-wrap></sec>
<sec><title>Discussion</title><p>The hypothesis was refuted by later work${" in detail".repeat(120)}.</p></sec></body><back><ref-list><ref>REF_SECRET</ref></ref-list></back></article>`;

test("JATS sections come from sec-type and titles, without tables or references", () => {
  const text = jatsText(JATS)!;
  expect(text.abstract).toBe("Short abstract & aims.");
  expect(text.introduction).toContain("Origins of the entropic brain idea");
  expect(text.discussion).toContain("refuted by later work");
  expect(text.methods).toContain("Scanner details.");
  expect(text.body).not.toContain("TABLE_SECRET");
  expect(text.body).not.toContain("REF_SECRET");
  expect(text.headings).toEqual(["Introduction", "Methods", "Discussion"]);
});

test("PDF text splits at numbered and plain headings, and says when it had to guess", () => {
  const raw = ["Title of paper", "Abstract", "We studied things.", "1. Introduction", "Background prose.", "2 Methods", "Procedure.", "RESULTS", "Numbers 42.", "Discussion", "Meaning of 42.", ...Array(12).fill("More discussion of what the result changed for the field."), "References", "Cited 1999"].join("\n");
  const text = pdfText(`${raw}\n`);
  expect(text.introduction).toBe("Background prose.");
  expect(text.discussion).toStartWith("Meaning of 42.");
  expect(text.discussion).not.toContain("Cited 1999");
  expect(text.results).toBe("Numbers 42.");
  expect(text.body).not.toContain("Cited 1999");
  const unmarked = pdfText(`${"Plain prose without headings. ".repeat(80)}\nReferences\nx`);
  expect(unmarked.notes.join(" ")).toContain("25%");
  expect(partOf("III. CONCLUSIONS")).toBe("conclusion");
  expect(partOf("Results and Discussion")).toBe("discussion");
});

test("reading text follows the paper type", () => {
  const text = jatsText(JATS)!;
  expect(readingText("R", text, null).text).toContain("[Body]");
  const original = readingText("O", text, null);
  expect(original.text).toContain("[Introduction]");
  expect(original.text).toContain("[Discussion (opening)]");
  expect(original.text).not.toContain("Scanner details");
  expect(original.basis).toBe("jats");
  expect(readingText("O", null, "Only the abstract")).toMatchObject({ basis: "abstract", text: "[Abstract]\nOnly the abstract" });
  expect(readingText("O", null, null).basis).toBe("none");
});

test("metadata settles reviews and meta-analyses; PMCIDs are normalized", () => {
  const work = blankWork({ type: "article", raw: { ids: { pmcid: "https://www.ncbi.nlm.nih.gov/pmc/articles/123456" } } });
  expect(pmcidOf(work)).toBe("PMC123456");
  expect(typeFromMetadata(work, ["Journal Article", "Meta-Analysis"])?.type).toBe("M");
  expect(typeFromMetadata(work, ["Review"])?.type).toBe("R");
  expect(typeFromMetadata({ ...work, type: "review" }, undefined)?.type).toBe("R");
  expect(typeFromMetadata(work, ["Randomized Controlled Trial"])?.type).toBe("O");
  expect(typeFromMetadata(work, ["Journal Article"])).toBeNull();
});

test("prepare fixes the corpus, fills metadata, types every paper and reads JATS, PDF or the abstract", async () => {
  const f = await fixture();
  const review = await f.add({ title: "The entropic brain", openalex: "W1", pmid: "111", type: "review", references: ["W9"], abstract: "Review abstract", year: 2014 });
  const original = await f.add(
    { title: "Psilocybin MEG study", openalex: "W2", references: ["W1"], abstract: "MEG abstract", year: 2013 },
    { pdfPages: ["Psilocybin MEG study", "Introduction", ...Array(30).fill("Prior work suggested decreased blood flow in hubs."), "Methods", "Fifteen volunteers.", "Discussion", "Desynchronization not suppression.", "References", "Old reference 1990"] },
  );
  const bare = await f.add({ title: "Tangential essay", doi: "10.1234/bare", references: null, abstract: "Essay abstract", year: 2020 });
  const filters: string[] = [];
  const asked: string[] = [];
  const engine = f.engine(
    {
      oa: {
        page: async (params: Record<string, string>): Promise<Page> => {
          filters.push(params.filter);
          return { works: [blankWork({ openalex: "W3", doi: "10.1234/bare", title: "Tangential essay", references: ["W1", "W2"], source: "openalex" })], cursor: null, total: 1, cached: false, fetchedAt: new Date().toISOString() };
        },
      } as never,
      fetcher: async (url) => {
        const u = String(url);
        if (u.includes("esummary")) return Response.json({ result: { uids: ["111"], 111: { pubtype: ["Journal Article", "Review"] } } });
        if (u.includes("europepmc/webservices/rest/search")) {
          expect(new URL(u).searchParams.get("query")).toContain("(EXT_ID:111 AND SRC:MED)");
          return Response.json({ resultList: { result: [{ pmid: "111", pmcid: "PMC777", isOpenAccess: "Y" }, { doi: "10.1234/bare", pmcid: "PMC888", isOpenAccess: "N" }] } });
        }
        if (u.includes("europepmc") && u.includes("PMC777")) return new Response(JATS);
        return new Response("", { status: 404 });
      },
    },
    {
      codex: {
        async complete(request) {
          const input = JSON.parse(request.input) as { papers: { key: string; hint: string | null }[] };
          asked.push(...input.papers.map((p) => `${p.key}:${p.hint ?? "-"}`));
          return JSON.stringify({ papers: input.papers.map((p) => ({ key: p.key, type: p.hint ? p.hint[0] : p.key === bare.citekey ? "P" : "O", reason: "판정" })) });
        },
      },
    },
  );
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "환각제 기전", settings: f.settings() });
  expect(g.startSize).toBe(3);
  engine.start(g.id, "prepare", false);
  const done = await settle(engine, g.id);
  expect(done.job).toMatchObject({ status: "completed", step: "prepare" });
  expect(done.completed.prepare).toBeTruthy();
  expect(existsSync(done.workspace)).toBe(true);
  expect(filters).toEqual(["doi:https://doi.org/10.1234/bare"]);
  expect(f.db.get(bare.id).references).toEqual(["W1", "W2"]);
  const papers = new Map(f.store.papers(g.id).map((p) => [p.workId, p]));
  expect(papers.get(review.id)).toMatchObject({ type: "R", basis: "jats", typeSource: "ai", pmcid: "PMC777" });
  expect(papers.get(bare.id)).toMatchObject({ pmcid: null, pmcChecked: true });
  expect(asked.find((a) => a.startsWith(review.citekey))).toContain("R (PubMed 출판 유형: Journal Article, Review)");
  expect(papers.get(original.id)).toMatchObject({ type: "O", basis: "pdf", hasPdf: true });
  expect(papers.get(original.id)!.textNote).toContain("서론");
  expect(papers.get(bare.id)).toMatchObject({ type: "P", basis: "abstract" });
  expect(f.events.some((e) => e.type === "genealogy")).toBe(true);
});

test("the corpus follows the collection, keeps cards of departed papers, and survives a merge", async () => {
  const f = await fixture();
  const a = await f.add({ title: "Paper A", openalex: "W10", references: [] });
  const b = await f.add({ title: "Paper B", openalex: "W11", references: [] });
  const engine = f.engine();
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "t", settings: f.settings() });
  f.store.saveCard(g.id, b.id, { key: b.citekey } as never);
  f.db.db.prepare("DELETE FROM collection_works WHERE work_id=?").run(b.id);
  engine.sync(g);
  expect(f.store.paper(g.id, b.id)).toMatchObject({ included: false });
  expect(f.store.card(g.id, b.id)).toMatchObject({ key: b.citekey });
  const c = await f.add({ title: "Paper A duplicate", doi: "10.9999/dup", references: [] });
  engine.sync(g);
  mergeWorks(f.db, a.id, c.id);
  expect(f.store.papers(g.id).filter((p) => p.included).map((p) => p.workId)).toEqual([a.id]);
  engine.setType(g.id, a.id, "M");
  expect(f.store.paper(g.id, a.id)).toMatchObject({ type: "M", typeSource: "user" });
});

test("missing PDFs go to the archive's full-text job and the job waits for it", async () => {
  const f = await fixture();
  const w = await f.add({ title: "Needs a PDF", openalex: "W20", references: [], abstract: "abs" });
  const started: unknown[] = [];
  const engine = f.engine(
    {
      downloads: {
        active: new Map(),
        sciHub: () => ({ enabled: true, mirrors: [] }),
        start(target: unknown) {
          started.push(target);
          const run = { id: "download-run", projectId: f.projectId, mode: "search", query: "", seedProfileId: null, inputIds: [], filters: {}, status: "completed", createdAt: "", updatedAt: "", calls: 0, maxCalls: 0, maxCandidates: 1, total: 1, count: 1, message: "1편 확보", tasks: [], rankingVersion: "" };
          f.db.saveRun(run as never);
          return run;
        },
        control() {},
      } as never,
    },
    { codex: { async complete(r) { const input = JSON.parse(r.input); return JSON.stringify({ papers: input.papers.map((p: { key: string }) => ({ key: p.key, type: "O", reason: "원저" })) }); } } },
  );
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "t", settings: f.settings({ fetchPdfs: true }) });
  engine.start(g.id, "prepare", false);
  const done = await settle(engine, g.id);
  expect(done.job?.status).toBe("completed");
  expect(started).toEqual([{ projectId: f.projectId, scope: "selected", ids: [w.id], includeBooks: false, useBrowser: false, interactive: false, useSciHub: true }]);
});

test("a spent subscription pauses the job instead of failing it", async () => {
  const f = await fixture();
  await f.add({ title: "Paper", openalex: "W30", references: [] });
  const engine = f.engine({}, { codex: { async complete() { throw new Error("Codex 구독 사용 한도에 도달했습니다."); } } });
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "t", settings: f.settings() });
  engine.start(g.id, "prepare", false);
  const done = await settle(engine, g.id);
  expect(done.job).toMatchObject({ status: "paused" });
  expect(done.completed.prepare).toBeUndefined();
});

test("reports made when routes copied the Settings model follow Settings again; other choices stay", async () => {
  const f = await fixture();
  await f.add({ title: "Paper", openalex: "W40", references: [] });
  const first = f.engine();
  const g = first.create({
    projectId: f.projectId,
    collectionId: f.collectionId,
    title: "옛 리포트",
    settings: f.settings({ routes: { light: { provider: "ollama", model: "deepseek-v4.1-flash:1017" }, cards: { provider: "ollama", model: "gpt-oss:120b" }, write: { provider: "claude", model: "opus" } } }),
  });
  f.engine({ models: () => ({ ollama: "deepseek-v4.1-flash:1017", claude: "opus", codex: "" }) });
  expect(f.store.get(g.id).settings.routes).toEqual({
    light: { provider: "ollama", model: "" },
    cards: { provider: "ollama", model: "gpt-oss:120b" },
    write: { provider: "claude", model: "" },
  });
});
