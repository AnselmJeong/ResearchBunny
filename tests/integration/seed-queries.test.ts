import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { Service } from "../../src/service/service";
import { Discovery } from "../../src/service/discovery/engine";
import { OpenAlex, fromOpenAlex } from "../../src/service/providers/openalex";
import type { AIProvider } from "../../src/service/providers/openai";
import { schemas } from "../../src/shared/contracts";
import { AppError, DEFAULT_FILTERS, type SeedProfile } from "../../src/shared/types";

const QUESTION = "내수용감각은 사회 인지와 어떻게 연결되는가?";
function raw(n: number, title: string, abstract: string, refs: number[] = []) {
  return {
    id: `https://openalex.org/W${n}`,
    doi: `https://doi.org/10.9999/${n}`,
    title,
    publication_year: 2020,
    type: "article",
    cited_by_count: 2,
    authorships: [{ author: { display_name: "Lee, A" } }],
    referenced_works: refs.map((r) => `https://openalex.org/W${r}`),
    related_works: [],
    topics: [],
    abstract_inverted_index: Object.fromEntries(abstract.split(" ").map((w, i) => [w, [i]])),
  };
}
// W3 shares no words with the seed, so only English queries can rank it.
const graph = [
  raw(1, "Interoception and social cognition", "interoception social cognition", [2]),
  raw(2, "Interoception foundation", "interoception foundation"),
  raw(3, "Heartbeat perception accuracy", "heartbeat perception accuracy"),
  raw(4, "Interoception followup", "interoception followup", [1]),
];
function openalex(db: Library, searches: string[] = []) {
  return new OpenAlex(db, () => undefined, async (input) => {
    const u = new URL(String(input));
    const filter = u.searchParams.get("filter") || "";
    if (u.searchParams.has("search")) searches.push(u.searchParams.get("search")!);
    const results = filter.startsWith("openalex:")
      ? graph.filter((w) => filter.slice(9).split("|").some((id) => w.id.endsWith("/" + id)))
      : filter.startsWith("cites:")
        ? graph.filter((w) => w.referenced_works.some((r) => r.endsWith("/" + filter.slice(6))))
        : graph;
    return new Response(JSON.stringify({ results, meta: { count: results.length, next_cursor: null } }));
  });
}
function model(answer: () => Promise<string[]>) {
  const asked: string[] = [];
  const ai = {
    seedQueries: (question: string) => {
      asked.push(question);
      return answer();
    },
  } as unknown as AIProvider;
  return { asked, ai };
}
async function fixture(fn: (db: Library) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-seed-queries-"));
  const db = new Library(join(root, "library"));
  try {
    await fn(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function finished(db: Library, id: string) {
  for (let i = 0; i < 6000; i++) {
    const r = db.run(id);
    if (!["queued", "running"].includes(r.status)) return r;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Job timed out");
}
const related = (d: Discovery, projectId: string, id: string) =>
  d.start({ projectId, mode: "related", query: QUESTION, ids: [id], filters: { ...DEFAULT_FILTERS } });

test("a related search asks the model once for English queries, searches and ranks with them", () =>
  fixture(async (db) => {
    const p = db.projects()[0].id;
    const seed = db.upsert(fromOpenAlex(graph[0])).work;
    db.setSeeds(p, [seed.id], QUESTION, {});
    const searches: string[] = [];
    const { asked, ai } = model(async () => ["heartbeat perception", "interoceptive accuracy"]);
    const d = new Discovery(db, openalex(db, searches), () => {}, ai);
    const r = await finished(db, related(d, p, seed.id).id);
    assert.equal(r.status, "completed");
    assert.deepEqual(searches, ["heartbeat perception", "interoceptive accuracy"]);
    const history = db.seedHistory(p);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].queries, ["heartbeat perception", "interoceptive accuracy"]);
    assert(db.candidates(r.id).find((e) => e.work.openalex === "W3")!.evidence.score! > 0);
    await finished(db, related(d, p, seed.id).id);
    assert.deepEqual(asked, [QUESTION]);
  }));

test("without English queries the initial search uses the seed title, never the question", () =>
  fixture(async (db) => {
    const p = db.projects()[0].id;
    const seed = db.upsert(fromOpenAlex(graph[0])).work;
    db.setSeeds(p, [seed.id], QUESTION, {});
    const failing = model(async () => {
      throw new AppError("CODEX_PROVIDER", "Codex 요청이 실패했습니다.");
    }).ai;
    const off = model(async () => {
      throw new AppError("AI_DISABLED", "설정에서 AI 연결을 선택하세요.");
    }).ai;
    for (const [ai, noted] of [[failing, true], [off, false], [undefined, false]] as const) {
      const d = new Discovery(db, openalex(db), () => {}, ai);
      const r = await finished(db, related(d, p, seed.id).id);
      assert.equal(r.status, "completed");
      assert.deepEqual(r.tasks.filter((t) => t.kind === "search").map((t) => t.query), [seed.title]);
      assert.equal(r.message.includes("seed 제목으로 검색"), noted);
      assert.equal(db.candidates(r.id).find((e) => e.work.openalex === "W3")!.evidence.score, 0);
    }
    assert.equal(db.seedHistory(p)[0].queries, undefined);
  }));

test("saving the seed writes English queries once per question and keeps the user's own", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-seed-save-"));
  const service = new Service(root, "unused", () => {});
  try {
    const p = service.db.projects()[0].id;
    const seed = service.db.upsert(fromOpenAlex(graph[0])).work;
    const asked: string[] = [];
    let answer = async () => ["interoception social cognition"];
    service.ai.seedQueries = async (question: string) => {
      asked.push(question);
      return answer();
    };
    const save = (input: Record<string, unknown>): Promise<SeedProfile> =>
      service.call("setSeeds", schemas.setSeeds.parse({ projectId: p, ids: [seed.id], ...input }));
    assert.deepEqual((await save({ question: QUESTION })).queries, ["interoception social cognition"]);
    assert.deepEqual((await save({ question: QUESTION })).queries, ["interoception social cognition"]);
    assert.deepEqual(asked, [QUESTION]);
    const edited = await save({ question: QUESTION, queries: [" heartbeat   perception ", "Heartbeat perception", ""] });
    assert.deepEqual(edited.queries, ["heartbeat perception"]);
    assert.equal(asked.length, 1);
    answer = async () => {
      throw new AppError("CODEX_PROVIDER", "Codex 요청이 실패했습니다.");
    };
    const failed = await save({ question: "다른 질문" });
    assert.equal(failed.question, "다른 질문");
    assert.equal(failed.queries, undefined);
    assert.equal((await save({ question: "" })).queries, undefined);
    assert.deepEqual(asked, [QUESTION, "다른 질문"]);
    assert.equal(service.db.seedHistory(p).length, 5);
  } finally {
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
