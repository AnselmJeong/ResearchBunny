import { afterEach, expect, test } from "bun:test";
import { genealogyFixture, settle, type Fixture } from "./genealogy-helpers";
import { parseOutline } from "../../src/service/genealogy/outline";
import { readingText } from "../../src/service/genealogy/sections";
import { blankWork } from "../../src/shared/domain";
import type { Page } from "../../src/service/providers/openalex";
import type { GenealogySettings, Outline } from "../../src/shared/genealogy";
import type { Work } from "../../src/shared/types";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await genealogyFixture();
  fixtures.push(f);
  return f;
}

/** One stand-in model for every genealogy prompt; `log` records which prompts ran. */
function model(log: string[], answers: { missing?: (section: string, call: number) => { need: string; hint: string; kind: string }[]; choose?: (input: { requests: { id: string; options: { id: string }[] }[] }) => { id: string; choice: string; reason: string }[]; place?: (input: { papers: { key: string }[]; sections: { id: string }[] }) => { key: string; sections: string[] }[] } = {}) {
  const sections = new Map<string, number>();
  return {
    async complete(request: { instruction: string; input: string }) {
      const input = JSON.parse(request.input);
      const i = request.instruction;
      if (i.includes("Classify each paper")) {
        log.push("classify");
        return JSON.stringify({ papers: input.papers.map((p: { key: string }) => ({ key: p.key, type: "O", reason: "원저" })) });
      }
      if (i.includes("You read one paper")) {
        log.push(`card:${input.paper.key}`);
        const quote = String(input.text).replace(/^\[Abstract\]\n/, "").split(/(?<=\.)\s/)[0];
        return JSON.stringify({ position: "", problem: "문제", claims: ["주장"], evidence: [{ text: "근거", quote }], critique: "", unresolved: [], interests: "", significance: `${input.paper.title}의 의의`, foundations: [], statusSignals: [], cautions: [] });
      }
      if (i.includes("Each candidate is a paper the corpus leans on")) {
        log.push(`judge:${input.candidates.length}`);
        return JSON.stringify({ candidates: input.candidates.map((c: { id: string }) => ({ id: c.id, role: "origin", relevance: c.id === "W500" ? 0 : 0.9, reason: "기반 연구" })) });
      }
      if (i.includes("sections asked for sources")) {
        log.push("choose");
        return JSON.stringify({ choices: answers.choose?.(input) ?? input.requests.filter((r: { options: unknown[] }) => r.options.length).map((r: { id: string }) => ({ id: r.id, choice: `${r.id}.0`, reason: "원전" })) });
      }
      if (i.includes("New papers joined a genealogy review")) {
        log.push(`place:${input.papers.map((p: { key: string }) => p.key).join(",")}`);
        return JSON.stringify({ papers: answers.place?.(input) ?? input.papers.map((p: { key: string }) => ({ key: p.key, sections: [input.sections[0].id] })) });
      }
      if (i.includes("You write one section")) {
        const call = (sections.get(input.section.id) ?? 0) + 1;
        sections.set(input.section.id, call);
        log.push(`write:${input.section.id}:${input.cards.map((c: { key: string }) => c.key).join(",")}`);
        const key = input.cards[0]?.key;
        return JSON.stringify({
          markdown: `${input.section.title}의 논지 [@${key}]. ${"흐름 속 의미를 설명한다. ".repeat(20)}`,
          summary: `${input.section.id} 요약`,
          missingSources: answers.missing?.(input.section.id, call) ?? [],
        });
      }
      throw new Error(`unexpected prompt: ${i.slice(0, 60)}`);
    },
  };
}

function openAlex(records: Record<string, Work>, searches: string[] = []) {
  return {
    page: async (params: Record<string, string>): Promise<Page> => {
      if (params.search) {
        searches.push(params.search);
        const works = Object.values(records).filter((w) => params.search.toLowerCase().split(" ").some((t) => t.length > 3 && w.title.toLowerCase().includes(t)));
        return { works, cursor: null, total: works.length, cached: false, fetchedAt: "" };
      }
      const ids = params.filter?.startsWith("openalex:") ? params.filter.slice(9).split("|") : [];
      const works = ids.map((id) => records[id]).filter(Boolean);
      return { works, cursor: null, total: works.length, cached: false, fetchedAt: "" };
    },
  } as never;
}

const auto = (f: Fixture, patch: Partial<GenealogySettings> = {}) => f.settings({ expansion: "auto", growth: 0.5, perRound: 15, rounds: 3, ...patch });

test("automatic gap rounds adopt the best candidates within the growth limit, then prepare and card them", async () => {
  const f = await fixture();
  // W900 is shared by all four papers, W800 by three, W700 by two: the room for two takes the first two.
  for (let i = 1; i <= 4; i++) await f.add({ title: `Corpus ${i}`, openalex: `W${i}`, year: 2010 + i, references: ["W900", ...(i <= 3 ? ["W800"] : []), ...(i <= 2 ? ["W700"] : []), "W500"], abstract: `Corpus paper ${i} has a quotable opening sentence.` });
  const records: Record<string, Work> = {
    W900: blankWork({ openalex: "W900", title: "Foundation one", authors: ["Ann Origin"], year: 2001, references: [], abstract: "Foundation one states the original idea." }),
    W800: blankWork({ openalex: "W800", title: "Foundation two", authors: ["Bob Second"], year: 2003, references: [], abstract: "Foundation two refined the original idea." }),
    W700: blankWork({ openalex: "W700", title: "Foundation three", authors: ["Cid Third"], year: 2005, references: [], abstract: "Foundation three tested the idea." }),
    W500: blankWork({ openalex: "W500", title: "Unrelated", authors: ["Dee Off"], year: 2005, references: [], abstract: "Off topic." }),
  };
  const log: string[] = [];
  const engine = f.engine({ oa: openAlex(records) }, { codex: model(log) });
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "자동", settings: auto(f) });
  engine.start(g.id, "gaps", false);
  const done = await settle(engine, g.id, 60000);
  expect(done.job).toMatchObject({ status: "completed" });
  expect(done.job!.message).toContain("자동 채택 2편");
  expect(done.rounds).toBe(1);
  const added = f.store.papers(g.id).filter((p) => p.origin !== "collection");
  expect(added.map((p) => p.title).sort()).toEqual(["Foundation one", "Foundation two"]);
  expect(added.every((p) => p.cardStatus === "done" && p.reason.startsWith("자동 채택") && p.round === 0)).toBe(true);
  expect(added.every((p) => f.db.state(f.projectId, p.workId).screening === "included")).toBe(true);
  expect(engine.budget(engine.store.get(g.id))).toEqual({ added: 2, cap: 2, room: 0 });
  expect(f.store.candidates(g.id).find((c) => c.id === "W700")!.decision).toBe("pending");
  expect(f.store.candidates(g.id).find((c) => c.id === "W500")!.score).toBe(0);
  // The four collection papers had no cards yet either, so the round cards them too.
  expect(log.filter((l) => l.startsWith("card:"))).toHaveLength(6);
});

test("suggest mode leaves candidates for the reader", async () => {
  const f = await fixture();
  for (let i = 1; i <= 3; i++) await f.add({ title: `Corpus ${i}`, openalex: `W${i}`, year: 2010 + i, references: ["W900"], abstract: "x" });
  const engine = f.engine({ oa: openAlex({ W900: blankWork({ openalex: "W900", title: "Foundation", authors: ["A B"], year: 2001 }) }) }, { codex: model([]) });
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "제안", settings: auto(f, { expansion: "suggest" }) });
  engine.start(g.id, "gaps", false);
  const done = await settle(engine, g.id, 60000);
  expect(done.rounds).toBe(0);
  expect(f.store.papers(g.id).every((p) => p.origin === "collection")).toBe(true);
  expect(f.store.candidates(g.id)[0].decision).toBe("pending");
});

async function outlined(f: Fixture, settings: GenealogySettings, log: string[], answers: Parameters<typeof model>[1], records: Record<string, Work> = {}, searches: string[] = []) {
  const a = await f.add({ title: "Entropy study", authors: ["Robin Carhart-Harris"], openalex: "W1", year: 2014, references: [], abstract: "Entropy rose under the drug in hubs." });
  const b = await f.add({ title: "Plasticity study", authors: ["Calvin Ly"], openalex: "W2", year: 2018, references: [], abstract: "Spines grew after a single dose." });
  const engine = f.engine({ oa: openAlex(records, searches) }, { codex: model(log, answers) });
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "요청", settings });
  for (const w of [a, b]) {
    const reading = readingText("O", null, w.abstract);
    f.store.savePaper(g.id, { ...f.store.paper(g.id, w.id)!, cardStatus: "done", type: "O", typeSource: "ai", basis: reading.basis, textNote: reading.note, textSize: reading.text.length, pmcChecked: true });
    f.store.saveCard(g.id, w.id, { key: w.citekey, type: "O", position: "", problem: "p", claims: [], evidence: [], critique: "", unresolved: [], interests: "", significance: "s", foundations: [], statusSignals: [], cautions: [] });
  }
  const { outline } = parseOutline(
    { title: "T", subtitle: "", summary: "", chapters: [{ title: "엔트로피", thesis: "", sections: [{ title: "엔트로피의 출발", thesis: "t", questions: [], evidence: "", keys: [a.citekey], branches: [] }] }, { title: "가소성", thesis: "", sections: [{ title: "가소성", thesis: "t", questions: [], evidence: "", keys: [b.citekey], branches: [] }] }] },
    new Set([a.citekey, b.citekey]),
    true,
  );
  await engine.saveOutline(engine.store.get(g.id), outline, []);
  const saved = engine.store.get(g.id);
  saved.completed = { prepare: "x", cards: "x", gaps: "x", outline: "x" };
  saved.outlineApproved = true;
  f.store.save(saved);
  return { engine, g: saved, a, b };
}

test("a source the writer asked for is found in the archive first, adopted, carded, and its section rewritten with it", async () => {
  const f = await fixture();
  // In the project's archive but not in the collection.
  const tononi = f.db.upsert(blankWork({ title: "Neural complexity and consciousness", authors: ["Giulio Tononi", "Gerald Edelman"], year: 1998, openalex: "W77", references: [], abstract: "Complexity measures integration across the brain.", source: "openalex" })).work;
  f.db.mutate(f.projectId, [tononi.id], { screening: "included" });
  const log: string[] = [];
  const searches: string[] = [];
  const { engine, g, a, b } = await outlined(f, auto(f, { growth: 1 }), log, { missing: (id, call) => (id === "1.1" && call === 1 ? [{ need: "복잡도 개념의 원전", hint: "Tononi and Edelman 1998", kind: "primary" }] : []) }, {}, searches);
  engine.start(g.id, "write", false);
  const done = await settle(engine, g.id, 60000);
  expect(done.job).toMatchObject({ status: "completed" });
  expect(done.job!.message).toContain("요청 논문 자동 채택 1편");
  expect(searches).toEqual([]);
  expect(log.filter((l) => l.startsWith("write:"))).toEqual([`write:1.1:${a.citekey}`, `write:2.1:${b.citekey}`, `write:1.1:${a.citekey},${tononi.citekey}`]);
  const paper = f.store.paper(g.id, tononi.id)!;
  expect(paper).toMatchObject({ origin: "archive", adoptedFrom: "included", cardStatus: "done" });
  expect(paper.reason).toContain("집필 요청: 1.1 엔트로피의 출발");
  const section = engine.store.state<Outline>(g.id, "outline")!.chapters[0].sections[0];
  expect(section).toMatchObject({ status: "written", rewrites: 1, keys: [a.citekey, tononi.citekey] });
  expect(section.missing).toEqual([]);
  expect(f.store.candidates(g.id).find((c) => c.workId === tononi.id)).toMatchObject({ decision: "added", requests: [{ section: "1.1 엔트로피의 출발", need: "복잡도 개념의 원전", uid: section.uid }] });
});

test("in suggest mode a requested source waits; accepting it marks the section for rewriting, undoing takes it back out", async () => {
  const f = await fixture();
  const log: string[] = [];
  const searches: string[] = [];
  const records = { W88: blankWork({ openalex: "W88", title: "Criticality in neural systems", authors: ["Dante Chialvo"], year: 2010, references: [], abstract: "Criticality maximises repertoire." }) };
  const { engine, g } = await outlined(f, auto(f, { expansion: "suggest" }), log, { missing: (id) => (id === "2.1" ? [{ need: "임계성 원전", hint: "Chialvo 2010 criticality", kind: "primary" }] : []) }, records, searches);
  engine.start(g.id, "write", false);
  await settle(engine, g.id, 60000);
  expect(searches).toEqual(["Chialvo 2010 criticality"]);
  const candidate = f.store.candidates(g.id).find((c) => c.id === "W88")!;
  expect(candidate).toMatchObject({ decision: "pending", role: "집필 요청" });
  await engine.decide(g.id, "W88", "accept");
  let outline = engine.store.state<Outline>(g.id, "outline")!;
  const added = f.store.papers(g.id).find((p) => p.title === "Criticality in neural systems")!;
  expect(outline.chapters[1].sections[0]).toMatchObject({ status: "stale" });
  expect(outline.chapters[1].sections[0].keys).toContain(added.key);
  expect(engine.store.get(g.id).completed).toMatchObject({ outline: "x" });
  expect(engine.store.get(g.id).completed.write).toBeUndefined();
  // Continuing prepares and cards the new paper and rewrites only that section.
  log.length = 0;
  engine.start(g.id, "continue", false);
  await settle(engine, g.id, 60000);
  expect(log).toEqual(["classify", `card:${added.key}`, `write:2.1:${outline.chapters[1].sections[0].keys.join(",")}`]);
  engine.removeAdded(g.id, added.workId);
  outline = engine.store.state<Outline>(g.id, "outline")!;
  expect(outline.chapters[1].sections[0].status).toBe("stale");
  expect(outline.chapters[1].sections[0].keys).not.toContain(added.key);
});

test("papers added to the collection after the outline are carded and placed into sections", async () => {
  const f = await fixture();
  const log: string[] = [];
  const { engine, g } = await outlined(f, auto(f, { expansion: "off" }), log, { place: (input) => input.papers.map((p) => ({ key: p.key, sections: ["2.1", "9.9"] })) });
  engine.start(g.id, "write", false);
  await settle(engine, g.id, 60000);
  const late = await f.add({ title: "Late arrival", openalex: "W55", year: 2022, references: [], abstract: "A late paper adds a new result here." });
  log.length = 0;
  engine.start(g.id, "write", false);
  const done = await settle(engine, g.id, 60000);
  expect(done.job?.status).toBe("completed");
  expect(log).toEqual(["classify", `card:${late.citekey}`, `place:${late.citekey}`, expect.stringMatching(new RegExp(`^write:2\\.1:.*${late.citekey}$`))]);
  expect(f.store.paper(g.id, late.id)!.placed).toBe(true);
  // Asked once: a later run does not ask about it again.
  log.length = 0;
  engine.start(g.id, "write", false);
  await settle(engine, g.id, 60000);
  expect(log).toEqual([]);
});
