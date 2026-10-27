import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { genealogyFixture, settle, type Fixture } from "./genealogy-helpers";
import { clusters, outlineMarkdown, parseOutline, parseOutlineMarkdown } from "../../src/service/genealogy/outline";
import { coCitations, parseMention, resolveMention, score, surname } from "../../src/service/genealogy/gaps";
import { blankWork } from "../../src/shared/domain";
import type { Page } from "../../src/service/providers/openalex";
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

test("mentions resolve inside the citing paper's references by surname and year", () => {
  expect(parseMention("Tononi and Edelman (1998)")).toEqual({ name: "tononi", year: 1998 });
  expect(parseMention("Carhart-Harris et al., 2014b")).toEqual({ name: "carhart-harris", year: 2014 });
  expect(parseMention("[12] Smith et al.")).toBeNull();
  expect(surname("Robin L. Carhart-Harris")).toBe("carhart-harris");
  expect(surname("Ménard, Pierre")).toBe("menard");
  const refs = [
    blankWork({ openalex: "W1", authors: ["Giulio Tononi", "Gerald Edelman"], year: 1998 }),
    blankWork({ openalex: "W2", authors: ["Giulio Tononi"], year: 2004 }),
    blankWork({ openalex: "W3", authors: ["Karl Friston"], year: 2010 }),
  ];
  expect(resolveMention("Tononi and Edelman (1998)", refs)?.openalex).toBe("W1");
  expect(resolveMention("Friston 2009", refs)?.openalex).toBe("W3");
  expect(resolveMention("Smith 1998", refs)).toBeNull();
});

test("co-citation weighs reviews, and scores rise with every signal", () => {
  const co = coCitations([
    { key: "a", type: "R", references: ["X", "Y"] },
    { key: "b", type: "O", references: ["X", "Z"] },
    { key: "c", type: "O", references: ["X", "Y", "C"] },
  ], new Set(["C"]));
  expect(co[0]).toEqual({ id: "X", citers: ["a", "b", "c"], weight: 3.5 });
  expect(co.find((c) => c.id === "C")).toBeUndefined();
  const base = { cocited: ["a", "b"], mentions: [], cites: [], requests: [], relevance: 0.5 };
  expect(score({ ...base, mentions: [{ key: "a", text: "X 2001", role: "origin" }] }, 10)).toBeGreaterThan(score(base, 10));
  expect(score({ ...base, requests: [{ section: "1.1", need: "원전" }] }, 10)).toBeGreaterThan(score(base, 10));
});

test("clusters group papers that cite each other or share references", () => {
  const groups = clusters([
    { key: "a", openalex: "A", refs: new Set(["B", "X1", "X2"]) },
    { key: "b", openalex: "B", refs: new Set(["X1", "X2"]) },
    { key: "c", openalex: "C", refs: new Set(["Y1", "Y2", "D"]) },
    { key: "d", openalex: "D", refs: new Set(["Y1", "Y2"]) },
  ]);
  expect(groups.map((g) => g.sort()).sort()).toEqual([["a", "b"], ["c", "d"]]);
});

const outlineReply = (keys: string[]) => ({
  title: "환각제 기전의 계보",
  subtitle: "2012–2026",
  summary: "요지 문장.",
  chapters: [
    { title: "문제는 어떻게 생겼나", thesis: "혈류 감소가 출발점이었다.", sections: [{ title: "혈류 감소라는 사고", thesis: "예상이 배반되었다.", questions: ["무엇이 관찰되었나"], evidence: "ASL 연구", keys: keys.slice(0, 1), branches: ["b1"] }] },
    { title: "엔트로피 가지", thesis: "측정이 의식론이 되었다.", sections: [{ title: "정식화", thesis: "2014년의 정식화.", questions: [], evidence: "", keys: keys.slice(1), branches: ["b1"] }, { title: "내부 비판", thesis: "같은 학파가 뒤집었다.", questions: ["재현되는가", "비특이적인가"], evidence: "재현 연구", keys: keys.slice(1, 2), branches: [] }] },
  ],
});

test("outlines check keys, report unassigned papers and survive an edit of 00_contents.md", () => {
  const keys = new Set(["k1", "k2", "k3"]);
  expect(() => parseOutline(outlineReply(["k1"]), keys, true)).toThrow("in no section");
  const { outline, unassigned } = parseOutline(outlineReply(["k1", "k2"]), keys, false);
  expect(unassigned).toEqual(["k3"]);
  expect(outline.chapters[1].sections.map((s) => s.id)).toEqual(["2.1", "2.2"]);
  expect(outline.chapters[0].file).toBe("01_문제는_어떻게_생겼나.md");
  const markdown = outlineMarkdown(outline);
  expect(markdown).toContain("### 2.2 내부 비판\n<!-- rb:section keys=k2 branches= -->");
  expect(markdown).toContain("- 다룰 질문: 재현되는가 / 비특이적인가");
  const written = { ...outline, chapters: outline.chapters.map((c) => ({ ...c, sections: c.sections.map((s) => ({ ...s, status: "written" as const, summary: "요약" })) })) };
  const edited = parseOutlineMarkdown(
    markdown.replace("### 2.1 정식화", "### 새 절\n- 논지: 사용자가 더한 절\n\n### 2.1 정식화").replace("### 1.1 혈류 감소라는 사고", "### 1.1 혈류 감소라는 사고(고침)"),
    written,
  );
  expect(edited.title).toBe("환각제 기전의 계보");
  expect(edited.summary).toBe("요지 문장.");
  expect(edited.chapters[0].sections[0]).toMatchObject({ title: "혈류 감소라는 사고(고침)", status: "planned", keys: ["k1"] });
  expect(edited.chapters[1].sections.map((s) => [s.id, s.title, s.status])).toEqual([
    ["2.1", "새 절", "planned"],
    ["2.2", "정식화", "written"],
    ["2.3", "내부 비판", "written"],
  ]);
  expect(edited.chapters[1].thesis).toBe("측정이 의식론이 되었다.");
});

test("gaps find shared references, card mentions and recent citers; adoption and undo move papers in and out", async () => {
  const f = await fixture();
  const a = await f.add({ title: "Review A", openalex: "W100", type: "review", year: 2014, references: ["W900", "W800"], abstract: "a" });
  const b = await f.add({ title: "Study B", openalex: "W200", year: 2016, references: ["W900"], abstract: "b" });
  const c = await f.add({ title: "Study C", openalex: "W300", year: 2018, references: ["W900", "W100"], abstract: "c" });
  const records: Record<string, Work> = {
    W900: blankWork({ openalex: "W900", title: "Shared foundation", authors: ["Karl Friston"], year: 2010, abstract: "foundation" }),
    W800: blankWork({ openalex: "W800", title: "Integration theory", authors: ["Giulio Tononi", "Gerald Edelman"], year: 1998 }),
    W700: blankWork({ openalex: "W700", title: "Recent synthesis", authors: ["New Author"], year: 2025, references: ["W100", "W200", "W300"] }),
  };
  const asked: string[] = [];
  const engine = f.engine(
    {
      oa: {
        page: async (params: Record<string, string>): Promise<Page> => {
          asked.push(params.filter);
          const ids = params.filter.startsWith("openalex:") ? params.filter.slice(9).split("|") : [];
          const works = params.filter.startsWith("cites:") ? [records.W700, blankWork({ openalex: "W600", title: "Narrow", references: ["W100"] })] : ids.map((id) => records[id]).filter(Boolean);
          return { works, cursor: null, total: works.length, cached: false, fetchedAt: "" };
        },
      } as never,
    },
    {
      codex: {
        async complete(request) {
          const input = JSON.parse(request.input);
          return JSON.stringify({ candidates: input.candidates.map((x: { id: string }) => ({ id: x.id, role: x.id === "W700" ? "review" : "origin", relevance: 0.9, reason: "근거" })) });
        },
      },
    },
  );
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "공백", settings: f.settings({ expansion: "suggest" }) });
  f.store.saveCard(g.id, a.id, { key: a.citekey, foundations: [{ mention: "Tononi and Edelman (1998)", role: "origin", claim: "통합" }] } as never);
  engine.start(g.id, "gaps", false);
  const done = await settle(engine, g.id);
  expect(done.job).toMatchObject({ status: "completed" });
  const candidates = new Map(f.store.candidates(g.id).map((x) => [x.id, x]));
  expect(candidates.get("W900")).toMatchObject({ cocited: [a.citekey, b.citekey, c.citekey], role: "출발점", decision: "pending" });
  expect(candidates.get("W800")!.mentions).toEqual([{ key: a.citekey, text: "Tononi and Edelman (1998)", role: "origin" }]);
  expect(candidates.get("W700")).toMatchObject({ cites: [a.citekey, b.citekey, c.citekey], role: "최신 정리" });
  expect(candidates.has("W600")).toBe(false);
  expect(f.store.state<{ recentCiters: Record<string, number> }>(g.id, "pack")!.recentCiters[a.citekey]).toBe(2);
  expect(asked.some((x) => x.startsWith("cites:"))).toBe(true);
  // Accepting adds the paper to the collection and the archive; undoing restores where it was.
  await engine.decide(g.id, "W900", "accept");
  const added = f.store.papers(g.id).find((p) => p.title === "Shared foundation")!;
  expect(added).toMatchObject({ origin: "openalex", adoptedFrom: null, included: true });
  expect(f.db.state(f.projectId, added.workId).screening).toBe("included");
  expect(f.store.collectionIds(engine.store.get(g.id))).toContain(added.workId);
  expect(engine.store.get(g.id).completed.prepare).toBeUndefined();
  engine.removeAdded(g.id, added.workId);
  expect(f.store.collectionIds(engine.store.get(g.id))).not.toContain(added.workId);
  expect(f.db.state(f.projectId, added.workId)).toMatchObject({ screening: "pending", pendingDismissed: true });
  expect(f.store.candidates(g.id).find((x) => x.id === "W900")!.decision).toBe("rejected");
  await engine.decide(g.id, "W800", "reject");
  expect(f.store.candidates(g.id).find((x) => x.id === "W800")!.decision).toBe("rejected");
});

test("the outline step builds the ledger and the contents, pauses for approval and reads an edited file back", async () => {
  const f = await fixture();
  const a = await f.add({ title: "Review A", openalex: "WA", year: 2014, references: [], abstract: "a" });
  const b = await f.add({ title: "Study B", openalex: "WB", year: 2016, references: ["WA"], abstract: "b" });
  const instructions: string[] = [];
  const engine = f.engine({}, {
    claude: {
      async complete(request) {
        instructions.push(request.instruction.slice(0, 40));
        const input = JSON.parse(request.input);
        if (request.instruction.includes("You are building the branch ledger"))
          return JSON.stringify({ branches: [{ name: "엔트로피 가지", origin: [a.citekey], claim: "주장", turningPoints: [{ key: b.citekey, note: "재현 실패" }], status: "blocked", evidence: "최근 인용 없음", reason: "재현되지 않음", lastActive: 2016 }] });
        expect(input.branches[0].id).toBe("b1");
        return JSON.stringify(outlineReply([a.citekey, b.citekey]));
      },
    },
  });
  const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "목차", settings: f.settings({ routes: { light: { provider: "claude", model: "" }, cards: { provider: "claude", model: "" }, write: { provider: "claude", model: "opus" } } }) });
  g.completed = { prepare: "x", cards: "x", gaps: "x" };
  f.store.save(g);
  engine.start(g.id, "continue", true);
  const done = await settle(engine, g.id);
  expect(done.job).toMatchObject({ status: "paused", step: "outline" });
  expect(done.job!.message).toContain("승인");
  expect(instructions).toHaveLength(2);
  const view = await engine.view(g.id);
  expect(view.contentsEdited).toBe(false);
  expect(view.branches[0]).toMatchObject({ id: "b1", status: "blocked", origin: [a.citekey] });
  expect(view.outline!.chapters).toHaveLength(2);
  const contents = await readFile(join(done.workspace, "00_contents.md"), "utf8");
  expect(contents).toStartWith("# 환각제 기전의 계보");
  expect(await readFile(join(done.workspace, "부록A_가지_장부.md"), "utf8")).toContain("| 엔트로피 가지 | 막힘 |");
  expect(() => engine.start(g.id, "continue", true)).toThrow();
  await writeFile(join(done.workspace, "00_contents.md"), contents.replace("## 2. 엔트로피 가지", "## 2. 엔트로피 가설의 흥망"));
  const synced = await engine.editOutline(g.id);
  expect(synced!.chapters[1].title).toBe("엔트로피 가설의 흥망");
  expect(await engine.edited(engine.store.get(g.id), "00_contents.md")).toBeNull();
  engine.approve(g.id);
  expect(engine.store.get(g.id).outlineApproved).toBe(true);
});
