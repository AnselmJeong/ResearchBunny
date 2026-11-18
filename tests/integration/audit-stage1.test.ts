import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Library } from "../../src/service/db/database";
import Database from "../../src/service/db/sqlite";
import { Discovery } from "../../src/service/discovery/engine";
import { GenealogyAI } from "../../src/service/genealogy/llm";
import { exportBib, parseBib } from "../../src/service/interchange/bibtex";
import { numbersOf } from "../../src/service/passages/answer";
import { OpenAlex } from "../../src/service/providers/openalex";
import { parsePubMedXml } from "../../src/service/search/pubmed-search";
import { blankWork, doiPath, normalizeDoi } from "../../src/shared/domain";
import { DEFAULT_FILTERS } from "../../src/shared/types";

async function fixture<T>(fn: (db: Library, root: string) => Promise<T> | T) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-audit-"));
  const db = new Library(join(root, "library"));
  try {
    return await fn(db, root);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("a DOI is the same DOI however it was written down", () => {
  // BibTeX export used to escape the underscore; re-import then stored a different DOI.
  expect(normalizeDoi("10.1007/978-3-030-1\\_7")).toBe("10.1007/978-3-030-1_7");
  expect(normalizeDoi("{10.1000/A_B}")).toBe("10.1000/a_b");
  expect(normalizeDoi("https://doi.org/10.1000/A_B.")).toBe("10.1000/a_b");
  expect(normalizeDoi("doi.org/10.1000/a_b")).toBe("10.1000/a_b");
  expect(normalizeDoi("https://www.doi.org/10.1000/a_b")).toBe("10.1000/a_b");
  expect(normalizeDoi("10.1000%2Fabc")).toBe("10.1000/abc");
  expect(normalizeDoi("(see 10.1000/abc)".slice(5))).toBe("10.1000/abc");
  // Brackets and the SICI hash that belong to the DOI stay.
  expect(normalizeDoi("10.1016/S0140-6736(20)30183-5")).toBe("10.1016/s0140-6736(20)30183-5");
  expect(normalizeDoi("10.1002/(SICI)1097-0258(19990815)18:15<1903::AID-SIM188>3.0.CO;2-#")).toBe("10.1002/(sici)1097-0258(19990815)18:15<1903::aid-sim188>3.0.co;2-#");
  expect(doiPath("10.1002/(sici)1097-0258<1903::aid>3.0.co;2-#")).not.toMatch(/[#?<>]/);
  expect(doiPath("10.1234/abc.def")).toBe("10.1234/abc.def");
});

test("BibTeX keeps DOIs, bracketed keys and backslashes intact across export and import", () => {
  const [entry] = parseBib("@article{10.1016/S0140-6736(20)30183-5,\n  title={Clinical features of patients},\n  author={Huang, C.},\n  year={2020}\n}");
  expect(entry.error).toBeUndefined();
  expect(entry.work?.title).toBe("Clinical features of patients");

  const work = blankWork({ title: "A chapter on a\\b", authors: ["Kim, J."], year: 2021, doi: "10.1007/978-3-030-1_7", url: "https://example.org/a_b?x=1&y=2", citekey: "kim2021" });
  const text = exportBib([work]).text;
  expect(text).toContain("10.1007/978-3-030-1_7");
  expect(text).toContain("https://example.org/a_b?x=1&y=2");
  expect(text).toContain("a\\textbackslash{}b");
  expect(parseBib(text)[0].work?.doi).toBe("10.1007/978-3-030-1_7");
});

test("correcting a DOI releases the wrong one for the paper it belongs to", () =>
  fixture((db) => {
    const mistaken = db.upsert(blankWork({ title: "Interoceptive inference in the insula", doi: "10.5555/other-paper", source: "manual" })).work;
    db.edit(mistaken.id, { doi: "10.5555/right-paper" });
    expect(db.findIdentifier("doi", "10.5555/other-paper")).toBeUndefined();
    expect(db.findIdentifier("doi", "10.5555/right-paper")).toBe(mistaken.id);
    const other = db.upsert(blankWork({ title: "Dopamine and reward prediction error", doi: "10.5555/other-paper", source: "manual" })).work;
    expect(other.id).not.toBe(mistaken.id);
    db.edit(mistaken.id, { doi: null });
    expect(db.findIdentifier("doi", "10.5555/right-paper")).toBeUndefined();
  }));

test("PubMed records give the publication year and their own DOI", () => {
  const [hit] = parsePubMedXml(`<PubmedArticle><MedlineCitation><PMID>15</PMID>
    <DateCompleted><Year>2006</Year></DateCompleted><DateRevised><Year>2023</Year></DateRevised>
    <Article><Journal><JournalIssue><PubDate><Year>2005</Year><Month>Mar</Month></PubDate></JournalIssue><Title>Brain</Title></Journal>
    <ArticleTitle>An old paper</ArticleTitle></Article></MedlineCitation>
    <PubmedData><ReferenceList><Reference><ArticleIdList><ArticleId IdType="doi">10.1000/cited</ArticleId></ArticleIdList></Reference></ReferenceList></PubmedData>
  </PubmedArticle>`);
  expect(hit.content).toContain("2005");
  expect(hit.content).not.toContain("2023");
  expect(hit.doi ?? "").not.toBe("10.1000/cited");
  const [own] = parsePubMedXml(`<PubmedArticle><PMID>16</PMID><Article><Journal><JournalIssue><PubDate><MedlineDate>1998 Dec-1999 Jan</MedlineDate></PubDate></JournalIssue></Journal><ArticleTitle>T</ArticleTitle><ELocationID EIdType="doi">10.1000/own</ELocationID></Article></PubmedArticle>`);
  expect(own.doi).toBe("10.1000/own");
  expect(own.content).toContain("1998");
});

test("the second reply is judged as a second reply even when the first was not JSON", () =>
  fixture(async (db) => {
    const replies = ['{"answer":"cut off', '{"answer":"lenient"}'];
    const attempts: number[] = [];
    const ai = new GenealogyAI(db, { codex: { async complete() { return replies.shift()!; } } });
    const result = await ai.json({
      runId: "run", instruction: "Answer.", input: "{}", schema: {}, signal: new AbortController().signal,
      route: { provider: "codex", model: "" },
      parse: (value, attempt) => { attempts.push(attempt); return z.object({ answer: z.string() }).parse(value); },
    });
    expect(result).toEqual({ answer: "lenient" });
    expect(attempts).toEqual([1]);
  }));

test("numbers in a passage support the same value written another way", () => {
  const allowed = numbersOf("The effect was significant (p < .05) in 1,234 patients; mean 12,5 and 0.420.");
  for (const n of ["0.05", "1234", "12.5", "0.42"]) expect(allowed.has(n)).toBe(true);
  expect(allowed.has("0.5")).toBe(false);
});

test("a seed OpenAlex does not know yet is left unresolved instead of failing the run", () =>
  fixture(async (db) => {
    const projectId = db.projects()[0].id;
    const seed = db.upsert(blankWork({ title: "A preprint published this week", doi: "10.5555/too-new", source: "manual" })).work;
    let calls = 0;
    const notFound: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async () => { calls++; return new Response("{}", { status: 404 }); };
    const discovery = new Discovery(db, new OpenAlex(db, () => undefined, notFound), () => {});
    const run = discovery.start({ projectId, mode: "references", query: "", ids: [seed.id], filters: { ...DEFAULT_FILTERS } });
    for (let i = 0; i < 500 && ["queued", "running"].includes(db.run(run.id).status); i++) await new Promise((r) => setTimeout(r, 10));
    const done = db.run(run.id);
    expect(done.status).toBe("completed");
    expect(done.message).toContain("미조회");
    expect(calls).toBe(1);
  }));

test("prepare() reuses the compiled statement and the database still closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-sqlite-"));
  try {
    const db = new Database(join(root, "t.sqlite"));
    db.exec("CREATE TABLE t(a INTEGER)");
    const insert = db.prepare("INSERT INTO t VALUES(?)");
    expect(db.prepare("INSERT INTO t VALUES(?)")).toBe(insert);
    for (let i = 0; i < 5; i++) db.prepare("INSERT INTO t VALUES(?)").run(i);
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 5 });
    // A statement reused while its earlier rows are still held gives independent results.
    const first = db.prepare("SELECT a FROM t WHERE a>=? ORDER BY a").all(3);
    const second = db.prepare("SELECT a FROM t WHERE a>=? ORDER BY a").all(0);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(5);
    expect(db.query("SELECT 1 AS one").get()).toEqual({ one: 1 });
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
