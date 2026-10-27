import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { genealogyFixture, settle, type Fixture } from "./genealogy-helpers";
import { citedKeys, dropCitations, numberCitations } from "../../src/shared/citations";
import { parseSection } from "../../src/service/genealogy/writer";
import { parseOutline } from "../../src/service/genealogy/outline";
import { genealogyTools } from "../../src/service/genealogy/tools";
import { familyFirst } from "../../src/service/genealogy/render";
import { readingText } from "../../src/service/genealogy/sections";
import type { GenealogyCard, Outline } from "../../src/shared/genealogy";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await genealogyFixture();
  fixtures.push(f);
  return f;
}

test("citation keys: brackets, narrative, locators, e-mails and trailing punctuation", () => {
  const text = "As shown [@Robin2014The; @b-2:x, p. 5]. @Calvin2018Psychedelics found it. Mail me@example.com. See @end.";
  expect(citedKeys(text)).toEqual(["Robin2014The", "b-2:x", "Calvin2018Psychedelics", "end"]);
  expect(dropCitations("A [@x; @y]. B [@x]. C @x 는", new Set(["x"]))).toBe("A [@y]. B. C 는");
  const order = new Map<string, number>();
  expect(numberCitations("A [@b; @a, p. 5]. @b 는 [@c].", order)).toBe("A [1, 2, p. 5]. [1] 는 [3].");
});

test("authors go to the bib family name first, so the style can abbreviate given names", () => {
  expect(familyFirst("Robin L. Carhart-Harris")).toBe("Carhart-Harris, Robin L.");
  expect(familyFirst("Ludwig van Beethoven")).toBe("van Beethoven, Ludwig");
  expect(familyFirst("Carhart-Harris, Robin")).toBe("Carhart-Harris, Robin");
  expect(familyFirst("홍길동")).toBe("홍길동");
});

const card = (claim: string): GenealogyCard => ({ key: "", type: "O", position: "", problem: "p", claims: [claim], evidence: [{ text: "혈류 20% 감소", quote: "decreased by 20%" }], critique: "", unresolved: [], interests: "", significance: "의의", foundations: [], statusSignals: [], cautions: [] });

test("sections cite only allowed keys: refused once, then cleaned and reported", () => {
  const pool = new Set(["20"]);
  const allowed = new Set(["a", "b"]);
  const text = (body: string) => ({ markdown: `## 1.1 제목\n\n${body} ${"설명 문장이 이어진다. ".repeat(20)}`, summary: "요약", missingSources: [{ need: "원전", hint: "Smith 1990", kind: "primary" }] });
  expect(() => parseSection(text("근거가 있다 [@a; @zzz]."), "제목", allowed, true, pool)).toThrow("not in allowedKeys");
  const lenient = parseSection(text("근거가 있다 [@a; @zzz]. 혈류는 20% 줄고 35% 늘었다."), "제목", allowed, false, pool);
  expect(lenient.markdown).toStartWith("근거가 있다 [@a].");
  expect(lenient.usedKeys).toEqual(["a"]);
  expect(lenient.problems.join(" ")).toContain("zzz");
  expect(lenient.problems.join(" ")).toContain("35");
  expect(lenient.problems.join(" ")).not.toContain("20,");
  expect(lenient.missing[0].hint).toBe("Smith 1990");
  expect(() => parseSection(text("번호 인용 [3]."), "제목", allowed, true, pool)).toThrow("numeric");
  expect(() => parseSection({ markdown: "짧다", summary: "", missingSources: [] }, "제목", allowed, false, pool)).toThrow();
});

async function written(f: Fixture) {
  const a = await f.add({ title: "Entropic brain", authors: ["Robin L. Carhart-Harris"], year: 2014, abstract: "a", venue: "Front Hum Neurosci", doi: "10.3389/fnhum.2014.00020" });
  const b = await f.add({ title: "Plasticity", authors: ["Calvin Ly"], year: 2018, abstract: "b", venue: "Cell Rep" });
  const calls: { section: string; previous: number; cards: string[] }[] = [];
  const engine = f.engine(
    { tools: genealogyTools },
    {
      codex: {
        async complete(request) {
          const input = JSON.parse(request.input);
          calls.push({ section: input.section.id, previous: input.previousSections.length, cards: input.cards.map((c: { key: string }) => c.key) });
          const key = input.cards[0]?.key ?? a.citekey;
          return JSON.stringify({
            markdown: `${input.section.title}의 논지를 세운다 [@${key}]. 혈류는 20% 감소했다. ${"이 실험은 경쟁 가설을 배제했다. ".repeat(15)}`,
            summary: `${input.section.id} 요약`,
            missingSources: input.section.id === "2.1" ? [{ need: "임계성 원전", hint: "Chialvo 2010", kind: "primary" }] : [],
          });
        },
      },
    },
  );
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "집필", settings: f.settings() });
  for (const [w, claim] of [[a, "엔트로피"], [b, "가소성"]] as const) {
    const reading = readingText("O", null, w.abstract);
    f.store.savePaper(g.id, { ...f.store.paper(g.id, w.id)!, cardStatus: "done", type: "O", typeSource: "ai", basis: reading.basis, textNote: reading.note, textSize: reading.text.length, pmcChecked: true });
    f.store.saveCard(g.id, w.id, { ...card(claim), key: w.citekey });
  }
  const { outline } = parseOutline(
    {
      title: "환각제 기전의 계보",
      subtitle: "2012–2026",
      summary: "요지.",
      chapters: [
        { title: "출발점", thesis: "혈류 감소가 출발점이었다.", sections: [{ title: "혈류 감소", thesis: "t", questions: [], evidence: "", keys: [a.citekey], branches: [] }] },
        { title: "갈라짐", thesis: "두 가지로 갈라졌다.", sections: [{ title: "엔트로피", thesis: "t", questions: [], evidence: "", keys: [a.citekey], branches: [] }, { title: "가소성", thesis: "t", questions: [], evidence: "", keys: [b.citekey], branches: [] }] },
      ],
    },
    new Set([a.citekey, b.citekey]),
    true,
  );
  await engine.saveOutline(engine.store.get(g.id), outline, []);
  const saved = engine.store.get(g.id);
  saved.completed = { prepare: "x", cards: "x", gaps: "x", outline: "x" };
  saved.outlineApproved = true;
  f.store.save(saved);
  return { engine, g: saved, a, b, calls };
}

test("writing follows the outline, carries summaries forward, then checks and renders the report", async () => {
  const f = await fixture();
  const { engine, g, a, b, calls } = await written(f);
  engine.start(g.id, "continue", true);
  const done = await settle(engine, g.id, 120000);
  expect(done.job).toMatchObject({ status: "completed", step: "render" });
  expect(calls.map((c) => [c.section, c.previous])).toEqual([["1.1", 0], ["2.1", 1], ["2.2", 2]]);
  expect(calls[2].cards).toEqual([b.citekey]);
  const outline = engine.store.state<Outline>(g.id, "outline")!;
  expect(outline.chapters[1].sections[0]).toMatchObject({ status: "written", summary: "2.1 요약", usedKeys: [a.citekey], missing: [{ need: "임계성 원전", hint: "Chialvo 2010", kind: "primary" }] });
  const chapter = await readFile(join(done.workspace, outline.chapters[1].file), "utf8");
  expect(chapter).toStartWith("# 2. 갈라짐\n\n**요지.** 두 가지로 갈라졌다.\n\n## 2.1 엔트로피\n\n엔트로피의 논지를 세운다");
  const checks = new Map(engine.store.state<{ id: string; ok: boolean; details: string[] }[]>(g.id, "checks")!.map((c) => [c.id, c]));
  expect(checks.get("written")!.ok).toBe(true);
  expect(checks.get("keys")!.ok).toBe(true);
  expect(checks.get("missing")!.details[0]).toContain("Chialvo 2010");
  const bib = await readFile(join(done.workspace, "환각제-기전의-계보.bib"), "utf8");
  expect(bib).toContain(`@article{${a.citekey},`);
  expect(bib).toContain("author = {Carhart-Harris, Robin L.}");
  expect(bib).toContain(`{${b.citekey},`);
  const md = await readFile(join(done.workspace, "build", "환각제-기전의-계보.md"), "utf8");
  expect(md).toStartWith('---\ntitle: "환각제 기전의 계보"');
  expect(md).toContain('csl: "vancouver.csl"');
  const tools = genealogyTools();
  const outputs = engine.store.state<{ epub: string | null; pdf: string | null; errors: string[] }>(g.id, "outputs")!;
  if (tools.pandoc) {
    expect(checks.get("citeproc")!.ok).toBe(true);
    expect(outputs.epub && existsSync(outputs.epub)).toBe(true);
    if (tools.typst) expect(outputs.pdf && existsSync(outputs.pdf)).toBe(true);
    expect(outputs.errors).toEqual([]);
  } else expect(outputs.errors[0]).toContain("pandoc");
});

test("a chapter the user edited is kept, and a rewritten section goes beside it", async () => {
  const f = await fixture();
  const { engine, g } = await written(f);
  engine.start(g.id, "write", false);
  await settle(engine, g.id, 60000);
  const outline = engine.store.state<Outline>(g.id, "outline")!;
  const file = join(g.workspace, outline.chapters[0].file);
  await writeFile(file, "# 1. 출발점\n\n사용자가 다시 쓴 장 [@nobody].\n");
  engine.rewrite(g.id, outline.chapters[0].sections[0].uid);
  const done = await settle(engine, g.id, 60000);
  expect(done.job?.status).toBe("completed");
  expect(await readFile(file, "utf8")).toContain("사용자가 다시 쓴 장");
  expect(existsSync(file.replace(/\.md$/, ".rb-new.md"))).toBe(true);
  expect(engine.store.state<Outline>(g.id, "outline")!.chapters[0].sections[0].rewrites).toBe(1);
  engine.start(g.id, "check", false);
  await settle(engine, g.id, 60000);
  const checks = new Map(engine.store.state<{ id: string; ok: boolean; details: string[] }[]>(g.id, "checks")!.map((c) => [c.id, c]));
  expect(checks.get("keys")).toMatchObject({ ok: false, details: ["nobody"] });
  expect(checks.get("edited")!.ok).toBe(false);
});
