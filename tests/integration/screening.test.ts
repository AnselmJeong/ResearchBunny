import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import {
  defaultProfile,
  recommend,
  scoreEvaluation,
  topicOf,
  type ScreenResult,
  type ScreeningProfile,
} from "../../src/shared/screening";
import { DecisionClient, type DecisionQuestion } from "../../src/service/screening/decision";
import { screenPapers, quoteFound, type ScreenPaper } from "../../src/service/screening/pipeline";
import { evaluateScreening, evaluationSet } from "../../src/service/screening/evaluate";
import { Screener } from "../../src/service/screening";
import { findAbstracts } from "../../src/service/screening/abstracts";
import type { JsonRequest } from "../../src/service/genealogy/llm";
import { DEFAULT_FILTERS, type Work } from "../../src/shared/types";

const profile = (patch: Partial<ScreeningProfile> = {}): ScreeningProfile => ({
  ...defaultProfile("p1", "clozapine augmentation in treatment-resistant schizophrenia"),
  include: [{ id: "human", text: "Studies in human patients" }],
  exclude: [{ id: "animal", text: "Animal or in vitro studies" }],
  ...patch,
});
const result = (patch: Partial<ScreenResult> = {}): ScreenResult => ({
  topic: "uncertain", relevance: null, criteria: {}, roles: {}, reason: "", quote: "", quoteChecked: false,
  basis: "abstract", stages: ["decision"], models: {}, promptVersion: "screen-1", criteriaVersion: 1, screenedAt: "", ...patch,
});
const paper = (id: string, abstract: string | null = `Abstract of ${id}: patients with schizophrenia received clozapine augmentation.`): ScreenPaper =>
  ({ id, title: `Paper ${id}`, abstract, year: 2020, venue: "J", type: "article" });

/** A decision model answering from a table: per paper id, per question name prefix. */
function fakeDecision(answers: (state: { paper: { title: string } }, name: string, q: DecisionQuestion) => number | string) {
  const calls: { state: unknown; names: string[] }[] = [];
  return {
    calls,
    configured: () => true,
    async ask(_model: string, state: string | Record<string, unknown>, questions: Record<string, DecisionQuestion>) {
      calls.push({ state, names: Object.keys(questions) });
      const s = state as { paper: { title: string } };
      return {
        answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => {
          const value = answers(s, name, q);
          if (q.type === "choice") return [name, { type: "choice" as const, choice: String(value), probabilities: { [String(value)]: 0.9 }, confidence: 0.8 }];
          if (q.type === "score") return [name, { type: "score" as const, score: Number(value) }];
          return [name, { type: "noul" as const, noul: Number(value) }];
        })),
        inputTokens: 100,
        outputTokens: 1,
      };
    },
  };
}
/** A generative model that judges every paper relevant and quotes its abstract. */
function fakeAI(judge: (id: string, input: { papers: { id: string; abstract: string }[] }) => Record<string, unknown> = () => ({})) {
  const calls: { input: { papers: { id: string; title: string; abstract: string }[]; examples: unknown[] } }[] = [];
  return {
    calls,
    async json<T>(request: JsonRequest<T>): Promise<T> {
      const input = JSON.parse(request.input);
      calls.push({ input });
      const papers = input.papers.map((p: { id: string; abstract: string }) => ({
        id: p.id, relevance: 3,
        criteria: [{ id: "human", verdict: "yes" }, { id: "animal", verdict: "no" }],
        roles: [], type: "unknown", contributions: [],
        reason: "사람 환자 대상 연구입니다.", quote: p.abstract.split(":")[1]?.trim().slice(0, 60) ?? "",
        ...judge(p.id, input),
      }));
      return request.parse({ papers }, 0);
    },
  };
}
const deps = (decision: ReturnType<typeof fakeDecision> | undefined, ai: ReturnType<typeof fakeAI> | undefined) =>
  ({ decision, ai, route: { provider: "codex" as const, model: "" }, runId: "test" });

test("exclusion needs a clear violation; anything short of it waits as 보류", () => {
  const p = profile();
  assert.equal(recommend(p, result({ relevance: 3, criteria: { human: { p: 0.95 }, animal: { p: 0.05 } } })).recommendation, "include");
  // An exclusion criterion that only probably applies is not enough.
  assert.equal(recommend(p, result({ relevance: 3, criteria: { human: { p: 0.95 }, animal: { p: 0.8 } } })).recommendation, "maybe");
  const off = recommend(p, result({ relevance: 3, criteria: { human: { p: 0.95 }, animal: { p: 0.97 } } }));
  assert.equal(off.recommendation, "exclude");
  assert.match(off.hits[0], /제외 기준 1: Animal/);
  // An inclusion criterion that clearly fails excludes too.
  assert.equal(recommend(p, result({ relevance: 3, criteria: { human: { p: 0.03 }, animal: { p: 0.1 } } })).recommendation, "exclude");
  // The generative model's verdict outranks the probability.
  assert.equal(recommend(p, result({ relevance: 3, criteria: { human: { p: 0.95, verdict: "yes" }, animal: { p: 0.97, verdict: "unclear" } } })).recommendation, "maybe");
  // A failure or a missing abstract never excludes.
  assert.equal(recommend(p, result({ error: "boom", criteria: { animal: { p: 0.99 } } })).recommendation, "maybe");
  assert.equal(recommend(p, result({ basis: "none" })).recommendation, "maybe");
  // Without criteria only an unrelated score excludes.
  const bare = profile({ include: [], exclude: [] });
  assert.equal(recommend(bare, result({ relevance: 0.2 })).recommendation, "exclude");
  assert.equal(recommend(bare, result({ relevance: 1.2 })).recommendation, "maybe");
  assert.equal(recommend(bare, result({ relevance: 3.4 })).recommendation, "include");
});

test("a relevant paper with no role for the purpose waits instead of being excluded", () => {
  const p = profile({ purpose: "original" });
  const r = result({ relevance: 3, criteria: { human: { p: 0.95 }, animal: { p: 0.05 } }, roles: { original: { answers: { primary: 0.1, method: 0.2, numbers: 0.1, comparable: 0.1 }, model: "clef", judgedAt: "" } } });
  const outcome = recommend(p, r);
  assert.equal(outcome.recommendation, "maybe");
  assert.match(outcome.roleNote, /원저 연구 목적에 맞는 역할 없음/);
  assert.equal(topicOf(p, r).topic, "relevant");
  // The same paper fits the genealogy purpose once its genealogy roles were asked.
  r.roles.genealogy = { answers: { concepts: 0.8 }, model: "clef", judgedAt: "" };
  assert.equal(recommend({ ...p, purpose: "genealogy" }, r).recommendation, "include");
});

test("the decision client posts named questions to systemone and maps errors", async () => {
  const seen: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const client = new DecisionClient(() => "key-1", async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: String((init?.headers as Record<string, string>).Authorization) });
    if (seen.length === 2) return new Response(JSON.stringify({ error: "model not found" }), { status: 404 });
    if (seen.length === 3) return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    return new Response(JSON.stringify({ model: "clef", answers: { "inc.human": { type: "noul", noul: 0.91 }, relevance: { type: "score", score: 3.2, legend: {}, probabilities: {}, confidence: 0.6 } }, usage: { input_tokens: 412, output_tokens: 2 } }));
  });
  const questions: Record<string, DecisionQuestion> = { "inc.human": { type: "noul", instructions: "Human?" }, relevance: { type: "score", instructions: "How relevant?", criteria: ["a", "b"] } };
  const reply = await client.ask("clef", { paper: { title: "T" } }, questions, AbortSignal.timeout(1000));
  assert.equal(seen[0].url, "https://ollama.com/v1/systemone");
  assert.equal(seen[0].auth, "Bearer key-1");
  assert.deepEqual(Object.keys(seen[0].body), ["model", "state", "questions"]);
  assert.equal(reply.inputTokens, 412);
  assert.equal(reply.answers["inc.human"].type === "noul" && reply.answers["inc.human"].noul, 0.91);
  await assert.rejects(client.ask("nope", "x", questions, AbortSignal.timeout(1000)), /‘nope’을 찾지 못했습니다/);
  await assert.rejects(client.ask("clef", "x", questions, AbortSignal.timeout(1000)), /질문 2개에 답하지 않았습니다/);
  await assert.rejects(new DecisionClient(() => "").ask("clef", "x", questions, AbortSignal.timeout(1000)), /Ollama Cloud API 키/);
});

test("two-stage screening: clear exclusions stop at the decision model, the rest get a generative reason", async () => {
  const decision = fakeDecision((state, name) => {
    const id = state.paper.title.split(" ")[1];
    if (name === "relevance") return 3;
    if (name === "exc.animal") return id === "rat" ? 0.98 : id === "maybe" ? 0.6 : 0.02;
    if (name === "inc.human") return 0.95;
    if (name === "char.type") return "O";
    return name.startsWith("role.") ? 0.8 : 0.1;
  });
  const ai = fakeAI();
  const outcome = await screenPapers(deps(decision, ai), {
    profile: profile(),
    papers: [paper("ok"), paper("rat"), paper("maybe"), paper("blank", null)],
    signal: AbortSignal.timeout(5000),
  });
  // No abstract: no model is asked and the paper waits.
  assert.equal(decision.calls.length, 3);
  assert.equal(outcome.results.get("blank")!.basis, "none");
  const p = profile();
  assert.equal(recommend(p, outcome.results.get("rat")!).recommendation, "exclude");
  assert.equal(outcome.results.get("rat")!.stages.join(), "decision");
  // The uncertain one and the recommended one went to the generative model, in one batch.
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(ai.calls[0].input.papers.map((x) => x.title).sort(), ["Paper maybe", "Paper ok"]);
  assert.equal(recommend(p, outcome.results.get("maybe")!).recommendation, "include");
  const ok = outcome.results.get("ok")!;
  assert.equal(ok.reason, "사람 환자 대상 연구입니다.");
  assert.equal(ok.quoteChecked, true);
  assert.deepEqual(ok.stages, ["decision", "generative"]);
  // The paper's character came with the decision request.
  assert.equal(outcome.characters.get("ok")!.type, "O");
});

test("a generative failure leaves decision judgments standing and unread papers 보류", async () => {
  const decision = fakeDecision((_s, name) => (name === "relevance" ? 3 : name === "inc.human" ? 0.95 : name === "char.type" ? "R" : name.startsWith("role.") ? 0.8 : 0.02));
  const failing = { calls: [], async json(): Promise<never> { throw new Error("subscription offline"); } };
  const outcome = await screenPapers(deps(decision, failing as unknown as ReturnType<typeof fakeAI>), { profile: profile(), papers: [paper("a")], signal: AbortSignal.timeout(5000) });
  const r = outcome.results.get("a")!;
  assert.equal(r.error, undefined);
  assert.equal(recommend(profile(), r).recommendation, "include");
  const genOnly = await screenPapers(deps(undefined, failing as unknown as ReturnType<typeof fakeAI>), { profile: { ...profile(), mode: "generative" }, papers: [paper("b")], signal: AbortSignal.timeout(5000) });
  assert.match(genOnly.results.get("b")!.error!, /subscription offline/);
  assert.equal(recommend(profile(), genOnly.results.get("b")!).recommendation, "maybe");
});

test("changing the purpose asks only the role questions again", async () => {
  const decision = fakeDecision((_s, name) => (name === "relevance" ? 3 : name === "inc.human" ? 0.95 : name === "char.type" ? "O" : name.startsWith("role.") ? 0.8 : 0.02));
  const first = await screenPapers(deps(decision, undefined), { profile: { ...profile(), mode: "decision" }, papers: [paper("a")], signal: AbortSignal.timeout(5000) });
  assert(decision.calls[0].names.includes("relevance"));
  assert(decision.calls[0].names.includes("role.concepts"));
  await screenPapers(deps(decision, undefined), {
    profile: { ...profile(), mode: "decision", purpose: "original" },
    papers: [paper("a")],
    existing: first.results,
    characters: first.characters,
    signal: AbortSignal.timeout(5000),
  });
  assert.deepEqual(decision.calls[1].names.sort(), ["role.comparable", "role.method", "role.numbers", "role.primary"]);
});

test("quotes must be the abstract's own words", () => {
  const p = paper("q", "We randomised 120 patients to clozapine plus aripiprazole or placebo.");
  assert.equal(quoteFound(p, "randomised 120 patients to clozapine"), true);
  assert.equal(quoteFound(p, "randomised 200 patients"), false);
  assert.equal(quoteFound(p, "short"), false);
});

test("evaluation scores each configuration on the person's decisions, reusing decision answers", async () => {
  const scored = scoreEvaluation({ mode: "decision", label: "x" }, new Map([["a", true], ["b", true], ["c", false]]), new Map([
    ["a", { recommendation: "include" as const, failed: false }],
    ["b", { recommendation: "exclude" as const, failed: false }],
    ["c", { recommendation: "exclude" as const, failed: false }],
  ]));
  assert.equal(scored.missed, 1);
  assert.equal(scored.missRate, 0.5);
  assert.equal(scored.caught, 1);
  assert.equal(scored.passed, false);
  const work = (id: string, relevant: boolean) => blankWork({ id, title: `Paper ${id}`, abstract: relevant ? `Patients: clozapine augmentation trial ${id}` : `Rats: animal model ${id}` });
  const relevant = Array.from({ length: 6 }, (_, i) => work(`r${i}`, true));
  const irrelevant = Array.from({ length: 6 }, (_, i) => work(`x${i}`, false));
  const decision = fakeDecision((state, name) => {
    const rat = state.paper.title.startsWith("Paper x");
    if (name === "relevance") return rat ? 1 : 3;
    if (name === "exc.animal") return rat ? 0.97 : 0.03;
    if (name === "inc.human") return rat ? 0.3 : 0.95;
    return 0.5;
  });
  const ai = fakeAI();
  const report = await evaluateScreening(deps(decision, ai), {
    profile: profile(), relevant, irrelevant, modes: ["decision", "two-stage", "generative"],
    examples: [{ title: "Paper r1", decision: "included" }, { title: "Other", decision: "rejected" }],
    signal: AbortSignal.timeout(5000),
  });
  // Twelve papers, asked once by the decision model across both of its configurations.
  assert.equal(decision.calls.length, 12);
  assert.deepEqual(report.scores.map((s) => s.mode), ["decision", "two-stage", "generative"]);
  const two = report.scores.find((s) => s.mode === "two-stage")!;
  assert.equal(two.calls.decision, 0);
  assert.equal(two.caught, 6);
  assert.equal(two.missed, 0);
  assert.equal(two.passed, true);
  assert(report.recommended);
  // Examples that are in the evaluation set are held back.
  for (const call of ai.calls) assert(!call.input.examples.some((e) => (e as { title: string }).title === "Paper r1"));
});

async function fixture(fn: (db: Library) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-screening-"));
  const db = new Library(join(root, "library"));
  try { await fn(db); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
const add = (db: Library, projectId: string, input: Partial<Work>, screening: "included" | "trash" | "pending" = "included") => {
  const { work } = db.upsert(blankWork({ source: "openalex", ...input }));
  db.mutate(projectId, [work.id], { screening });
  return work.id;
};
async function settle(screener: Screener) {
  for (let i = 0; i < 2000 && screener.active.size; i++) await Bun.sleep(2);
  assert.equal(screener.active.size, 0);
}

test("a screening job fills missing abstracts, saves judgments and marks them stale when criteria change", async () => fixture(async (db) => {
  const projectId = db.projects()[0].id;
  const withAbstract = add(db, projectId, { title: "Clozapine augmentation trial", doi: "10.1/a", abstract: "Patients: clozapine augmentation with aripiprazole." });
  const without = add(db, projectId, { title: "Clozapine case series", doi: "10.1/b", pmid: "123", abstract: null });
  const fetcher = async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("efetch")) return new Response("<PubmedArticle><PMID>123</PMID><Abstract><AbstractText>Patients: clozapine case series in resistant schizophrenia.</AbstractText></Abstract></PubmedArticle>");
    if (href.includes("esummary")) return new Response(JSON.stringify({ result: { uids: ["123"], "123": { pubtype: ["Case Reports"] } } }));
    return new Response(JSON.stringify({ resultList: { result: [] } }));
  };
  const decision = fakeDecision((_s, name) => (name === "relevance" ? 3 : name === "inc.human" ? 0.95 : name === "char.type" ? "R" : name.startsWith("role.") ? 0.8 : 0.02));
  const events: string[] = [];
  const screener = new Screener({ db, decision, ai: fakeAI(), route: () => ({ provider: "codex", model: "" }), emit: (e) => events.push(e.type), pubmedKey: () => undefined, fetcher: fetcher as never });
  screener.store.saveProfile(projectId, { include: [{ id: "human", text: "Studies in human patients" }], exclude: [{ id: "animal", text: "Animal studies" }] });
  const job = screener.start(projectId, { kind: "archive" });
  assert.equal(job.status, "running");
  await settle(screener);
  const snapshot = screener.snapshot(projectId);
  assert.equal(snapshot.job?.status, "completed", snapshot.job?.message ?? "");
  assert.equal(snapshot.job?.counts?.include, 2);
  assert.match(db.get(without).abstract!, /case series/);
  assert.equal(db.get(without).raw.abstractSource, "pubmed");
  // The type came from PubMed's record and stays; the model filled in contributions.
  const characters = screener.store.characters([without, withAbstract]);
  assert.equal(characters.get(without)!.type, "O");
  assert.equal(characters.get(without)!.source, "metadata");
  assert.equal(characters.get(withAbstract)!.type, "R");
  assert(events.includes("changed"));
  let views = screener.store.views(projectId, [withAbstract]);
  assert.equal(views.get(withAbstract)!.recommendation, "include");
  assert.equal(views.get(withAbstract)!.stale, false);
  // A purpose change is not a criterion change.
  screener.store.saveProfile(projectId, { purpose: "original" });
  assert.equal(screener.store.views(projectId, [withAbstract]).get(withAbstract)!.stale, false);
  screener.store.saveProfile(projectId, { exclude: [{ id: "animal", text: "Animal or in vitro studies" }] });
  views = screener.store.views(projectId, [withAbstract]);
  assert.equal(views.get(withAbstract)!.stale, true);
}));

test("the evaluation set pairs the archive with the trash, papers with abstracts only", async () => fixture(async (db) => {
  const projectId = db.projects()[0].id;
  const long = "x".repeat(100);
  for (let i = 0; i < 8; i++) add(db, projectId, { title: `Kept ${i}`, doi: `10.1/k${i}`, abstract: long });
  for (let i = 0; i < 4; i++) add(db, projectId, { title: `Gone ${i}`, doi: `10.1/g${i}`, abstract: long }, "trash");
  add(db, projectId, { title: "No abstract", doi: "10.1/n", abstract: null }, "trash");
  add(db, projectId, { title: "Waiting", doi: "10.1/w", abstract: long }, "pending");
  const set = evaluationSet(db.db, projectId, 5);
  assert.equal(set.relevant.length, 5);
  assert.equal(set.irrelevant.length, 4);
  assert(set.irrelevant.every((w) => w.title.startsWith("Gone")));
}));

test("abstracts come from PubMed by PMID, then Europe PMC by DOI", async () => {
  const works = [
    blankWork({ id: "a", pmid: "1", doi: "10.1/a" }),
    blankWork({ id: "b", doi: "10.1/B" }),
    blankWork({ id: "c", abstract: "already here" }),
  ];
  const urls: string[] = [];
  const found = await findAbstracts(works, {
    signal: AbortSignal.timeout(5000),
    fetcher: (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("efetch")) return new Response("<PubmedArticle><PMID>1</PMID><Abstract><AbstractText Label=\"BACKGROUND\">From PubMed.</AbstractText></Abstract></PubmedArticle>");
      return new Response(JSON.stringify({ resultList: { result: [{ doi: "10.1/b", abstractText: "<h4>Background</h4>From <i>Europe</i> PMC, long enough to count as an abstract here." }] } }));
    }) as never,
  });
  assert.equal(found.get("a")!.abstract, "BACKGROUND: From PubMed.");
  assert.equal(found.get("b")!.abstract, "Background From Europe PMC, long enough to count as an abstract here.");
  assert.equal(found.get("b")!.source, "europepmc");
  assert(!found.has("c"));
  assert.equal(urls.length, 2);
});

test("recommendations show on list rows, filter the list, and are archived only on request", async () => fixture(async (db) => {
  const projectId = db.projects()[0].id;
  const human = add(db, projectId, { title: "Human trial", doi: "10.2/h", abstract: "Patients: clozapine augmentation in humans." }, "pending");
  const rat = add(db, projectId, { title: "Rat study", doi: "10.2/r", abstract: "Rats: clozapine in an animal model." }, "pending");
  const decision = fakeDecision((state, name) => {
    const isRat = state.paper.title.startsWith("Rat");
    if (name === "relevance") return 3;
    if (name === "exc.animal") return isRat ? 0.97 : 0.02;
    if (name === "inc.human") return isRat ? 0.2 : 0.95;
    if (name === "char.type") return "O";
    if (name === "char.method") return isRat ? 0.9 : 0.1;
    return name.startsWith("role.") ? 0.8 : 0.1;
  });
  const screener = new Screener({ db, decision, ai: fakeAI(), route: () => ({ provider: "codex", model: "" }), emit: () => {}, pubmedKey: () => undefined, fetcher: (async () => new Response("{}")) as never });
  screener.store.saveProfile(projectId, { include: [{ id: "human", text: "Studies in human patients" }], exclude: [{ id: "animal", text: "Animal studies" }] });
  screener.start(projectId, { kind: "ids", ids: [human, rat] });
  await settle(screener);
  const list = (filters = {}) => db.list({ projectId, scope: "pending", query: "", filters: { ...DEFAULT_FILTERS, ...filters }, showHidden: false, offset: 0, limit: 100, sort: "title" });
  const rows = list().works;
  assert.equal(rows.find((w) => w.id === human)!.screen!.recommendation, "include");
  const ratRow = rows.find((w) => w.id === rat)!;
  assert.equal(ratRow.screen!.recommendation, "exclude");
  assert.match(ratRow.screen!.hits.join(), /제외 기준 1: Animal studies/);
  assert.equal(ratRow.character!.type, "O");
  // Filters show the matches only.
  assert.deepEqual(list({ screen: ["exclude"] }).works.map((w) => w.id), [rat]);
  assert.deepEqual(list({ character: ["method"] }).works.map((w) => w.id), [rat]);
  assert.deepEqual(list({ screen: ["none"] }).works.map((w) => w.id), []);
  // Nothing was archived by the job; accepting takes only the recommended paper.
  assert.equal(db.state(projectId, human).screening, "pending");
  assert.deepEqual(screener.acceptable(projectId, { kind: "ids", ids: [human, rat] }), [human]);
  // A changed criterion leaves the judgment stale, and stale recommendations are not archived.
  screener.store.saveProfile(projectId, { intent: "Something else entirely" });
  assert.deepEqual(screener.acceptable(projectId, { kind: "ids", ids: [human, rat] }), []);
  // The person's own type wins over the model's, and screening again keeps it.
  screener.setCharacter(rat, "R", ["debate"]);
  screener.start(projectId, { kind: "ids", ids: [rat] }, { fresh: true });
  await settle(screener);
  assert.equal(screener.store.characters([rat]).get(rat)!.type, "R");
  assert.equal(screener.store.characters([rat]).get(rat)!.source, "user");
  // A turned-down recommendation becomes a proposed exclusion criterion.
  const profile = screener.store.suggest(projectId, human, "  동물 연구가 아니라 증례라서 ");
  assert.equal(profile.suggestions[0].text, "동물 연구가 아니라 증례라서");
}));

test("the criteria draft reads the question, seeds and past decisions, and saves nothing", async () => fixture(async (db) => {
  const projectId = db.projects()[0].id;
  db.updateProject(projectId, "TRS", "클로자핀 증강 요법의 효과");
  add(db, projectId, { title: "Kept trial", doi: "10.3/k", abstract: "a" });
  add(db, projectId, { title: "Rejected rat study", doi: "10.3/r", abstract: "b" }, "trash");
  let input: { researchQuestion: string; keptPapers: { title: string }[]; rejectedPapers: { title: string }[] } | undefined;
  const ai = {
    async json<T>(request: JsonRequest<T>): Promise<T> {
      input = JSON.parse(request.input);
      return request.parse({ intent: "클로자핀 증강의 효과를 알고 싶다.", include: ["사람 대상", "사람 대상", " 증강 요법 "], exclude: ["동물 연구"] }, 0);
    },
  };
  const screener = new Screener({ db, decision: fakeDecision(() => 0), ai, route: () => ({ provider: "codex", model: "" }), emit: () => {}, pubmedKey: () => undefined });
  const draft = await screener.draft(projectId, AbortSignal.timeout(5000));
  assert.equal(input!.researchQuestion, "클로자핀 증강 요법의 효과");
  assert.deepEqual(input!.keptPapers.map((p) => p.title), ["Kept trial"]);
  assert.deepEqual(input!.rejectedPapers.map((p) => p.title), ["Rejected rat study"]);
  assert.deepEqual(draft.include, ["사람 대상", "증강 요법"]);
  assert.match(draft.basis, /연구 질문/);
  assert.equal(screener.store.hasProfile(projectId), false);
  const off = new Screener({ db, decision: fakeDecision(() => 0), ai, route: () => null, emit: () => {}, pubmedKey: () => undefined });
  await assert.rejects(off.draft(projectId, AbortSignal.timeout(5000)), /AI 추천·분류를 켜/);
}));
