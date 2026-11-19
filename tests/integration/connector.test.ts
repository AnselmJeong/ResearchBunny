import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Library } from "../../src/service/db/database";
import { PassageStore, PASSAGE_FILE } from "../../src/service/passages/store";
import { CHUNKER_VERSION } from "../../src/service/passages/chunker";
import { ScreeningStore } from "../../src/service/screening/store";
import { EvidenceStore } from "../../src/service/evidence";
import { blankWork } from "../../src/shared/domain";
import { ConnectorLibrary } from "../../src/connector/library";
import { McpServer, callLog } from "../../src/connector/mcp";

interface Fixture { root: string; data: string; projectId: string; trial: string; review: string; outside: string; folder: string }

/** A library with two archive papers whose PDFs are indexed, one paper outside the project, and a linked ScholarPen folder. */
async function fixture(fn: (f: Fixture) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-connector-"));
  const data = join(root, "library");
  const db = new Library(data);
  const projectId = db.projects()[0].id;
  db.updateProject(projectId, "TRS", "Does clozapine augmentation help?");
  const add = (title: string, doi: string, pmid: string | null, year: number, included = true) => {
    const work = db.upsert(blankWork({ title, doi, pmid, year, authors: ["Smith, Anna", "Park, Jun"], venue: "Schizophr Res", source: "openalex" })).work;
    if (included) db.mutate(projectId, [work.id], { screening: "included" });
    return work.id;
  };
  const trial = add("Aripiprazole augmentation of clozapine: a randomized trial", "10.1016/j.schres.2019.01.001", "30000001", 2019);
  const review = add("Clozapine augmentation strategies: a review", "10.1016/j.schres.2020.02.002", null, 2020);
  const outside = add("Ketamine in depression", "10.1016/j.jad.2021.03.003", null, 2021, false);
  const collection = db.createCollection(projectId, "Trials");
  db.db.prepare("INSERT INTO collection_works VALUES(?,?)").run(collection.id, trial);
  const screening = new ScreeningStore(db.db);
  screening.saveCharacter(trial, { type: "O", contributions: ["primary"], source: "ai", reason: "", judgedAt: "" });
  screening.saveCharacter(review, { type: "R", contributions: ["concept"], source: "metadata", reason: "", judgedAt: "" });
  const evidence = new EvidenceStore(db.db);
  // As after the app's first fill: the table's columns are saved.
  evidence.saveColumns(projectId, evidence.config(projectId).columns);
  evidence.saveRow(projectId, { workId: trial, basis: "fulltext", columnsVersion: 1, model: "x", filledAt: "", cells: { design: { value: "무작위 대조 시험", quote: "We randomised 120 patients", page: 3, pageEnd: 3, section: "Methods", passageId: 1, attachmentId: null, status: "ok" } } });
  db.db.prepare("INSERT INTO shelf_roots VALUES('r','/shelf','shelf','[]','2026-01-01',NULL)").run();
  db.db.prepare("INSERT INTO shelf_folders VALUES('f','r','',NULL,'',1)").run();
  for (const [id, workId, hash] of [["file-trial", trial, "hash-trial"], ["file-review", review, "hash-review"], ["file-out", outside, "hash-out"]])
    db.db.prepare("INSERT INTO shelf_files VALUES(?,?,?,?,1,1,?,NULL,NULL,?,NULL,'resolved','ok','{}','2026-01-01',NULL)").run(id, "r", "f", `${id}.pdf`, hash, workId);
  db.db.prepare("INSERT INTO project_links VALUES(?,?)").run(projectId, "TRS manuscript");
  db.close();
  const store = new PassageStore(join(data, PASSAGE_FILE));
  const chunks = (texts: [number, string, string][]) => ({ chunks: texts.map(([page, section, text], seq) => ({ seq, pageStart: page, pageEnd: page, section, text })), chars: 1000, referencesExcluded: true, pages: 10 });
  store.saveDoc("hash-trial", CHUNKER_VERSION, "trial", chunks([
    [3, "Methods", "We randomised 120 patients with treatment-resistant schizophrenia on clozapine to aripiprazole or placebo for twelve weeks."],
    [6, "Results", "Aripiprazole augmentation reduced PANSS total scores by 8.4 points compared with placebo (95% CI 3.1 to 13.7)."],
    [8, "Discussion", "The small sample and short follow-up limit conclusions about long-term benefit of augmentation."],
  ]));
  store.saveDoc("hash-review", CHUNKER_VERSION, "review", chunks([[2, "Introduction", "Clozapine augmentation with a second antipsychotic is common, but evidence from randomized trials remains mixed."]]));
  store.saveDoc("hash-out", CHUNKER_VERSION, "out", chunks([[1, "Results", "Ketamine augmentation reduced depressive symptoms within hours."]]));
  store.close();
  const folder = join(root, "_ScholarPen_", "TRS manuscript");
  await mkdir(join(folder, ".researchbunny"), { recursive: true });
  await writeFile(join(folder, ".researchbunny", "project.json"), JSON.stringify({ format: 1, app: "ResearchBunny", projectId }));
  try {
    await fn({ root, data, projectId, trial, review, outside, folder });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
type CallResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
const call = async (server: McpServer, name: string, args: unknown) => {
  const reply = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args as Record<string, unknown> } });
  return reply!.result as CallResult;
};
const body = <T>(result: CallResult) => result.structuredContent as T;

test("the connector lists tools as read-only and scopes to the linked folder it runs in", async () => fixture(async ({ data, projectId, folder }) => {
  const lib = new ConnectorLibrary(data, { cwd: folder });
  const server = new McpServer(lib, "0.0.0");
  try {
    const init = await server.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    assert.equal((init!.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    const tools = (await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }))!.result as { tools: { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { type: string } }[] };
    assert.deepEqual(tools.tools.map((t) => t.name), ["list_projects", "list_scopes", "list_works", "resolve_works", "find_support", "search_passages", "get_passages", "get_evidence", "get_bibtex"]);
    assert(tools.tools.every((t) => t.annotations.readOnlyHint && t.inputSchema.type === "object"));
    const projects = body<{ projects: { id: string; linkedFolder: string; current: boolean }[] }>(await call(server, "list_projects", {})).projects;
    assert.deepEqual(projects.map((p) => [p.id, p.linkedFolder, p.current]), [[projectId, "TRS manuscript", true]]);
    const scopes = body<{ archive: number; collections: { name: string; count: number }[]; characters: Record<string, number> }>(await call(server, "list_scopes", {}));
    assert.equal(scopes.archive, 2);
    assert.deepEqual(scopes.collections.map((c) => [c.name, c.count]), [["Trials", 1]]);
    assert.equal(scopes.characters.O, 1);
    assert.equal(scopes.characters.concept, 1);
    const unknown = (await server.handle({ jsonrpc: "2.0", id: 3, method: "resources/read" }))!;
    assert.equal(unknown.error?.code, -32601);
  } finally {
    lib.close();
  }
}));

test("find_support and search_passages stay inside the scope and return pages", async () => fixture(async ({ data, trial, review }) => {
  const lib = new ConnectorLibrary(data, { project: "TRS" });
  const server = new McpServer(lib, "0.0.0");
  try {
    type Passages = { passages: { workId: string; page: number; section: string; text: string; type: string | null; citekey: string }[]; semantic: boolean };
    const found = body<Passages>(await call(server, "find_support", { claim: "aripiprazole augmentation reduced PANSS scores" }));
    assert.equal(found.semantic, false);
    assert.equal(found.passages[0].workId, trial);
    assert.equal(found.passages[0].page, 6);
    assert.equal(found.passages[0].type, "O");
    // The shelf paper outside the project never shows in a project scope, only in the shelf scope.
    const augmentation = body<Passages>(await call(server, "search_passages", { query: "augmentation" }));
    assert(augmentation.passages.length >= 2);
    assert(augmentation.passages.every((p) => p.workId === trial || p.workId === review));
    const shelf = body<Passages>(await call(server, "search_passages", { query: "ketamine augmentation", scope: { kind: "shelf" } }));
    assert(shelf.passages.some((p) => p.text.startsWith("Ketamine")));
    // A collection, and papers of one type.
    const reviews = body<Passages>(await call(server, "search_passages", { query: "augmentation", scope: { kind: "character", character: "R" } }));
    assert.deepEqual([...new Set(reviews.passages.map((p) => p.workId))], [review]);
    const collection = body<Passages>(await call(server, "search_passages", { query: "augmentation", scope: { kind: "collection", name: "Trials" } }));
    assert.deepEqual([...new Set(collection.passages.map((p) => p.workId))], [trial]);
    const bad = await call(server, "search_passages", { query: "x y", scope: { kind: "collection", name: "Nope" } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /No collection Nope/);
    const pages = body<{ passages: { page: number }[] }>(await call(server, "get_passages", { workId: trial, pageFrom: 5, pageTo: 9 }));
    assert.deepEqual(pages.passages.map((p) => p.page), [6, 8]);
  } finally {
    lib.close();
  }
}));

test("resolve_works, list_works, get_evidence and get_bibtex", async () => fixture(async ({ data, trial, outside, root }) => {
  const logPath = join(root, "logs", "calls.jsonl");
  const lib = new ConnectorLibrary(data, { project: "TRS" });
  const server = new McpServer(lib, "0.0.0", callLog(logPath));
  try {
    type Resolved = { results: { found: boolean; match?: string; id?: string; inProject?: string | null; pdf?: boolean; indexed?: boolean }[] };
    const resolved = body<Resolved>(await call(server, "resolve_works", { items: [
      { doi: "https://doi.org/10.1016/J.SCHRES.2019.01.001" },
      { pmid: "30000001" },
      { title: "Ketamine in depression", year: 2021 },
      { doi: "10.9999/none" },
    ] }));
    assert.deepEqual(resolved.results.map((r) => [r.found, r.match, r.id]), [[true, "doi", trial], [true, "pmid", trial], [true, "title", outside], [false, undefined, undefined]]);
    assert.equal(resolved.results[0].inProject, "included");
    assert.equal(resolved.results[2].inProject, null);
    assert.equal(resolved.results[0].indexed, true);
    const works = body<{ total: number; works: { id: string; type: string; evidence?: Record<string, string> }[] }>(await call(server, "list_works", {}));
    assert.equal(works.total, 2);
    assert.deepEqual(works.works.find((w) => w.id === trial)!.evidence, { 설계: "무작위 대조 시험" });
    const evidence = body<{ found: boolean; cells: { column: string; value: string; page: number | null }[] }>(await call(server, "get_evidence", { workId: trial }));
    assert.equal(evidence.found, true);
    assert.deepEqual(evidence.cells.find((c) => c.column === "설계")!, { ...evidence.cells.find((c) => c.column === "설계")!, value: "무작위 대조 시험", page: 3 });
    const bib = body<{ bibtex: string }>(await call(server, "get_bibtex", { ids: [trial], keys: { [trial]: "smith2019aripiprazole" } }));
    assert.match(bib.bibtex, /^@article\{smith2019aripiprazole,/);
    assert.match(bib.bibtex, /pmid = \{30000001\}/);
    assert.match(bib.bibtex, /doi = \{10.1016\/j.schres.2019.01.001\}/);
    const invalid = await call(server, "get_bibtex", { ids: [] });
    assert.equal(invalid.isError, true);
    // Every call is logged with its outcome.
    const log = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tool: string; ok: boolean });
    assert.deepEqual(log.map((l) => [l.tool, l.ok]), [["resolve_works", true], ["list_works", true], ["get_evidence", true], ["get_bibtex", true], ["get_bibtex", false]]);
  } finally {
    lib.close();
  }
}));

test("the connector process speaks MCP on stdio and leaves the library unchanged", async () => fixture(async ({ data, folder }) => {
  const before = await readFile(join(data, "library.sqlite"));
  const child = spawn(process.execPath, ["src/connector/index.ts", "--data", data, "--no-log"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_works", arguments: { scope: { project: "TRS" } } } }) + "\n");
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  const replies = lines.map((l) => JSON.parse(l) as { id: number; result: { protocolVersion?: string; structuredContent?: { total: number } } });
  assert.equal(replies[0].result.protocolVersion, "2024-11-05");
  assert.equal(replies[1].result.structuredContent!.total, 2);
  assert.deepEqual(await readFile(join(data, "library.sqlite")), before);
  void folder;
}));
