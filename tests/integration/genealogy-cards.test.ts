import { afterEach, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { genealogyFixture, settle, type Fixture } from "./genealogy-helpers";
import { normalizeQuote, parseCard, splitText } from "../../src/service/genealogy/cards";
import { GenealogyEngine } from "../../src/service/genealogy/engine";

const fixtures: Fixture[] = [];
afterEach(async () => {
  GenealogyEngine.PART = 150_000;
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await genealogyFixture();
  fixtures.push(f);
  return f;
}

const card = (quotes: string[], extra: Record<string, unknown> = {}) => ({
  position: "선행 연구에 응답",
  problem: "문제",
  claims: ["주장"],
  evidence: quotes.map((quote, i) => ({ text: `근거 ${i + 1}`, quote })),
  critique: "",
  unresolved: [],
  interests: "확인되지 않음",
  significance: "출발점",
  foundations: [{ mention: "Tononi and Edelman (1998)", role: "origin", claim: "통합 정보" }],
  statusSignals: [],
  cautions: [],
  ...extra,
});

test("cards keep only evidence quoted from the text and flag numbers the text lacks", () => {
  const source = "Psilocybin decreased blood\nflow in hubs by 20%. The neuro-\nimaging data were noisy.";
  const parsed = parseCard(card(["decreased blood flow in hubs by 20%", "the neuroimaging data were noisy", "invented sentence that is absent"], { evidence: [
    { text: "혈류 20% 감소", quote: "decreased blood flow in hubs by 20%" },
    { text: "잡음 35%", quote: "The neuroimaging data were noisy." },
    { text: "없음", quote: "invented sentence that is absent" },
  ] }), source, "Key2012", "O", false);
  expect(parsed.evidence.map((e) => e.text)).toEqual(["혈류 20% 감소", "잡음 35%"]);
  expect(parsed.cautions.join(" ")).toContain("1개는 인용문이 원문과 일치하지 않아");
  expect(parsed.cautions.join(" ")).toContain("35");
  expect(parsed).toMatchObject({ key: "Key2012", type: "O" });
  expect(() => parseCard(card(["absent one here", "absent two here", "flow in hubs by 20%"]), source, "k", "O", true)).toThrow("not exact substrings");
  expect(normalizeQuote("“Neuro-\n imaging”  ")).toBe('"neuroimaging"');
});

test("long texts split at paragraph breaks", () => {
  const parts = splitText(["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n\n"), 70);
  expect(parts).toEqual([`${"a".repeat(30)}\n\n${"b".repeat(30)}`, "c".repeat(30)]);
  expect(splitText("x".repeat(25), 10)).toHaveLength(3);
});

test("the cards step reads each paper, merges long ones, records failures and writes card files", async () => {
  const f = await fixture();
  const first = await f.add({ title: "First paper", year: 2001, abstract: "Hubs lost 20% of their blood flow under the drug. A second sentence follows here." });
  const long = await f.add({ title: "Long review", year: 2010, abstract: `Opening claim of the long review is stated here clearly. ${"Middle material keeps going. ".repeat(30)}\n\nClosing claim of the long review is also stated here.` });
  const broken = await f.add({ title: "Broken quotes", year: 2020, abstract: "Real text of the broken paper sits in this sentence." });
  GenealogyEngine.PART = 400;
  const seen: string[] = [];
  const engine = f.engine({}, {
    claude: {
      async complete(request) {
        const input = JSON.parse(request.input);
        if (input.partialCards) {
          seen.push(`merge:${input.partialCards.length}`);
          return JSON.stringify(card(input.partialCards.flatMap((c: { evidence: { quote: string }[] }) => c.evidence.map((e) => e.quote))));
        }
        seen.push(`${input.paper.title}${request.instruction.includes("This is part") ? ":part" : ""}`);
        if (input.paper.title === "Broken quotes") return JSON.stringify(card(["not in the text at all one", "not in the text at all two"]));
        const sentence = input.text.split(/(?<=\.)\s/)[0].replace("[Abstract]\n", "");
        return JSON.stringify(card([sentence]));
      },
    },
  });
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "카드", settings: f.settings({ routes: { light: { provider: "claude", model: "" }, cards: { provider: "claude", model: "sonnet" }, write: { provider: "claude", model: "" } }, concurrency: 2 }) });
  engine.start(g.id, "cards", false);
  const done = await settle(engine, g.id);
  expect(done.job).toMatchObject({ status: "completed", step: "cards" });
  expect(done.job!.message).toContain("1편을 만들지 못했습니다");
  const papers = new Map(f.store.papers(g.id).map((p) => [p.workId, p]));
  expect(papers.get(first.id)).toMatchObject({ cardStatus: "done", basis: "abstract" });
  expect(papers.get(long.id)!.cardStatus).toBe("done");
  expect(papers.get(broken.id)).toMatchObject({ cardStatus: "failed" });
  expect(papers.get(broken.id)!.cardError).toContain("형식");
  expect(seen.filter((s) => s === "Long review:part").length).toBeGreaterThan(1);
  expect(seen).toContain(`merge:${seen.filter((s) => s === "Long review:part").length}`);
  expect(seen.filter((s) => s === "Broken quotes")).toHaveLength(2);
  expect(f.store.card(g.id, first.id)!.evidence[0].quote).toBe("Hubs lost 20% of their blood flow under the drug.");
  const files = await readdir(join(done.workspace, "cards"));
  expect(files).toEqual([`001_${first.citekey}.md`, `002_${long.citekey}.md`]);
  const markdown = await readFile(join(done.workspace, "cards", files[0]), "utf8");
  expect(markdown).toStartWith(`# ${first.citekey} — `);
  expect(markdown).toContain("“Hubs lost 20% of their blood flow under the drug.”");
  expect(markdown).toContain("Tononi and Edelman (1998) (출발점)");
  expect(engine.view(g.id).cards[first.id].key).toBe(first.citekey);
});

test("a spent quota stops every card worker and pauses the step", async () => {
  const f = await fixture();
  for (let i = 0; i < 6; i++) await f.add({ title: `Paper ${i}`, year: 2000 + i, abstract: `Sentence number ${i} is long enough to quote.` });
  let calls = 0;
  const engine = f.engine({}, { codex: { async complete() { calls++; await Bun.sleep(20); throw new Error("Codex 구독 사용 한도에 도달했습니다."); } } });
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "한도", settings: f.settings({ concurrency: 2 }) });
  engine.start(g.id, "cards", false);
  const done = await settle(engine, g.id);
  expect(done.job?.status).toBe("paused");
  expect(calls).toBeLessThanOrEqual(2);
  expect(f.store.papers(g.id).every((p) => p.cardStatus === "none")).toBe(true);
});
