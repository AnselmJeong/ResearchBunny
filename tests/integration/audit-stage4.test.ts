import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Library } from "../../src/service/db/database";
import { GenealogyAI } from "../../src/service/genealogy/llm";
import { extractPdfLines, type PdfLines } from "../../src/service/interchange/pdf";
import { chunk, paragraphs, split } from "../../src/service/passages/chunker";
import { openPassageStore } from "../../src/service/passages/store";
import { embedEach } from "../../src/service/providers/ollama-local";
import { AppError } from "../../src/shared/types";
import { genealogyFixture, settle } from "./genealogy-helpers";

const sentence = (topic: string, n: number) => `The ${topic} analysis number ${n} showed a reliable effect across the whole cohort of participants.`;
/** Pages of body-size lines; a string starting with "#" is a heading set a little larger. */
function doc(pages: string[][]): PdfLines {
  return {
    total: pages.length,
    pages: pages.map((lines) => ({
      width: 600,
      height: 800,
      lines: lines.map((text, i) => {
        const heading = text.startsWith("#");
        const t = heading ? text.slice(1) : text;
        return { t, x: 50, y: 700 - i * 14, w: heading ? 80 : t.length >= 60 ? 480 : t.length * 5, h: 10 };
      }),
    })),
  };
}
const body = (topic: string, count: number, from = 0) => Array.from({ length: count }, (_, i) => sentence(topic, from + i));

test("a reference list ends where the text starts again: methods after it and later chapters are kept", () => {
  const text = (lines: PdfLines) => paragraphs(lines);
  const nature = text(doc([
    ["#Introduction", ...body("introduction", 12)],
    ["#Results", ...body("results", 12), "#References", "1. Smith J, Jones M. A cited paper about something else. Journal 2001.", "2. Lee K. Another cited paper with a long enough title to fill a line. Brain 2010.", "12. Kim A", "#Methods", ...body("methods", 8)],
    [...body("methods", 6, 8), "#References", "31. Park S. A reference of the methods section. Neuron 2015.", "#Acknowledgements", "We thank the people who helped with this study and its analysis."],
  ]));
  const all = nature.paragraphs.map((p) => p.text).join(" ");
  expect(nature.referencesExcluded).toBe(true);
  expect(all).toContain("methods analysis number 0");
  expect(all).toContain("methods analysis number 13");
  expect(all).not.toMatch(/cited paper|Kim A|reference of the methods|We thank/);
  expect(nature.paragraphs.find((p) => p.text.includes("methods analysis number 3"))!.section).toBe("Methods");

  // An edited volume: each chapter has its own list, and the next chapter starts with a plain line.
  const book = text(doc([
    ["#Introduction", ...body("chapter one", 14), "#References", "1. Smith J. A cited book about the first chapter topic. Press 1999."],
    ["Chapter 2 Dopamine", ...body("chapter two", 14), "#References", "1. Lee K. A cited book about the second chapter topic. Press 2003."],
  ]));
  expect(book.paragraphs.map((p) => p.text).join(" ")).toContain("chapter two analysis number 13");
  expect(book.paragraphs.map((p) => p.text).join(" ")).not.toContain("cited book");

  // An ordinary article is unchanged: nothing after its list.
  const plain = text(doc([["#Introduction", ...body("introduction", 12), "#References", "1. Smith J. Only references follow here. Journal 2001."]]));
  expect(plain.referencesExcluded).toBe(true);
  expect(plain.paragraphs.every((p) => !p.text.includes("Only references"))).toBe(true);
});

test("a passage names every page its paragraphs run onto, and a cut-short PDF is marked", () => {
  const open = "This paragraph starts at the foot of the first page and its last line here does not end the sentence because it";
  const pages = doc([["#Results", ...body("first page", 6), open], ["continues at the top of the second page and only ends over there, well after the page break.", ...body("second page", 2)]]);
  const paras = paragraphs(pages).paragraphs;
  const crossing = paras.find((p) => p.text.includes("starts at the foot"))!;
  expect(crossing).toMatchObject({ page: 1, pageEnd: 2 });
  expect(crossing.text).toContain("only ends over there");
  const only = chunk([crossing]);
  expect(only[0]).toMatchObject({ pageStart: 1, pageEnd: 2 });
  expect(split({ ...pages, truncated: true }).truncated).toBe(true);
  expect(split(pages).truncated).toBeUndefined();
});

test("splitting a PDF again keeps the vectors of passages whose text did not change", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-keep-"));
  const store = openPassageStore(join(root, "passages.sqlite"));
  try {
    const part = (seq: number, text: string) => ({ seq, text, pageStart: seq + 1, pageEnd: seq + 1, section: "Results" });
    const first = { chunks: [part(0, "alpha passage"), part(1, "beta passage"), part(2, "gamma passage")], chars: 40, referencesExcluded: true, pages: 3 };
    store.saveDoc("hash1", "c1", "Paper", first);
    const ids = store.idsOf(["hash1"]);
    store.saveVectors("m", ids.map((id) => ({ id, vector: new Float32Array([1, 0, 0, 0]) })));
    expect(store.counts("m")).toMatchObject({ passages: 3, embedded: 3 });

    // The new split finds text after the reference list, moves one page range and rewrites one passage.
    store.saveDoc("hash1", "c2", "Paper", { ...first, chunks: [{ ...part(0, "alpha passage"), pageEnd: 2 }, part(1, "beta passage rewritten"), part(2, "gamma passage"), part(3, "methods passage")], truncated: true });
    expect(store.counts("m")).toMatchObject({ passages: 4, embedded: 2 });
    const kept = store.idsOf(["hash1"]);
    expect(kept).toContain(ids[0]);
    expect(kept).toContain(ids[2]);
    expect(kept).not.toContain(ids[1]);
    expect(store.pending("m", 0, 10).map((p) => p.text).sort()).toEqual(["beta passage rewritten", "methods passage"]);
    expect(store.docs().get("hash1")).toMatchObject({ chunker: "c2" });
    expect(store.lexical('"methods"', 5).length).toBe(1);
    expect(store.lexical('"beta"', 5).length).toBe(1);

    // A later reading that runs out of time leaves what is indexed in place; a PDF never read is marked failed.
    store.noteUnread("hash1", "retry:1", "Paper", "시간 초과");
    expect(store.counts("m")).toMatchObject({ ok: 1, passages: 4, embedded: 2, failed: 0 });
    expect(store.docs().get("hash1")).toMatchObject({ chunker: "retry:1" });
    store.noteUnread("hash2", "retry:1", "Other", "시간 초과");
    expect(store.counts("m")).toMatchObject({ ok: 1, failed: 1, passages: 4 });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one input the model refuses does not hold back the rest of its batch", async () => {
  const calls: number[] = [];
  const ollama = {
    async embed(_model: string, inputs: string[]) {
      calls.push(inputs.length);
      if (inputs.includes("bad")) throw new AppError("OLLAMA_EMBED", "Ollama 임베딩 실패 (500)", true);
      return inputs.map(() => new Float32Array([1]));
    },
  };
  const signal = new AbortController().signal;
  const out = await embedEach(ollama, "m", ["a", "bad", "c"], signal);
  expect(out.map((v) => !!v)).toEqual([true, false, true]);
  expect(calls).toEqual([3, 1, 1, 1]);
  // Nothing got through: that is the server, not the inputs.
  await expect(embedEach(ollama, "m", ["bad", "bad"], signal)).rejects.toMatchObject({ code: "OLLAMA_EMBED" });
  // A server that is off is reported at once.
  const off = { async embed(): Promise<Float32Array[]> { throw new AppError("OLLAMA_OFFLINE", "off", true); } };
  await expect(embedEach(off, "m", ["a", "b"], signal)).rejects.toMatchObject({ code: "OLLAMA_OFFLINE" });
});

test("a reader that runs out of time says so, apart from a PDF that cannot be read", async () => {
  const worker = resolve("dist/runtime/pdf-worker.cjs");
  const reasons: string[] = [];
  expect(await extractPdfLines(resolve("tests/fixtures/synthetic-local.pdf"), worker, AbortSignal.timeout(20000), { timeoutMs: 1, failed: (r) => reasons.push(r) })).toBeNull();
  expect(await extractPdfLines(resolve("package.json"), worker, AbortSignal.timeout(20000), { failed: (r) => reasons.push(r) })).toBeNull();
  expect(reasons).toEqual(["timeout", "unreadable"]);
  expect((await extractPdfLines(resolve("tests/fixtures/synthetic-local.pdf"), worker, AbortSignal.timeout(20000)))!.pages.length).toBeGreaterThan(0);
}, 30000);

test("a provider hiccup is asked again, a rate limit pauses, and a setup error is not retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-retry-"));
  const db = new Library(root);
  try {
    const base = { runId: "run", instruction: "Answer.", input: "{}", schema: {}, signal: new AbortController().signal, parse: (value: unknown) => z.object({ answer: z.string() }).parse(value) };
    let calls = 0;
    const flaky = new GenealogyAI(db, { codex: { async complete() { if (++calls < 3) throw new Error("socket hang up"); return '{"answer":"ok"}'; } } }, undefined, [1, 1]);
    expect(await flaky.json({ ...base, route: { provider: "codex", model: "" } })).toEqual({ answer: "ok" });
    expect(calls).toBe(3);

    calls = 0;
    const down = new GenealogyAI(db, { codex: { async complete() { calls++; throw new Error("socket hang up"); } } }, undefined, [1, 1]);
    await expect(down.json({ ...base, route: { provider: "codex", model: "" } })).rejects.toMatchObject({ code: "AI_PROVIDER" });
    expect(calls).toBe(3);

    const status = (code: number) => new AppError("OLLAMA_PROVIDER", `Ollama Cloud 응답 오류 (${code}). 키·모델·사용 한도를 확인하세요.`, true);
    calls = 0;
    const limited = new GenealogyAI(db, { ollama: { async complete() { calls++; throw status(429); } } }, undefined, [1, 1]);
    await expect(limited.json({ ...base, route: { provider: "ollama", model: "m" } })).rejects.toMatchObject({ code: "BUDGET" });
    expect(calls).toBe(1);

    calls = 0;
    const busy = new GenealogyAI(db, { ollama: { async complete() { if (++calls === 1) throw status(503); return '{"answer":"ok"}'; } } }, undefined, [1, 1]);
    expect(await busy.json({ ...base, route: { provider: "ollama", model: "m" } })).toEqual({ answer: "ok" });

    calls = 0;
    const unset = new GenealogyAI(db, { ollama: { async complete() { calls++; throw status(401); } } }, undefined, [1, 1]);
    await expect(unset.json({ ...base, route: { provider: "ollama", model: "m" } })).rejects.toMatchObject({ code: "OLLAMA_PROVIDER" });
    expect(calls).toBe(1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a provider that is down stops the cards step and leaves the papers to be read on the next run", async () => {
  const f = await genealogyFixture();
  try {
    for (const n of [1, 2, 3]) await f.add({ title: `Paper ${n}`, year: 2000 + n, abstract: `The abstract of paper ${n} states one clear finding about the topic.` });
    let up = false;
    let calls = 0;
    const engine = f.engine({}, {
      claude: {
        async complete(request) {
          calls++;
          if (!up) throw new Error("connect ECONNREFUSED 127.0.0.1");
          const sentence = JSON.parse(request.input).text.replace("[Abstract]\n", "");
          return JSON.stringify({ position: "선행 연구에 응답", problem: "문제", claims: ["주장"], evidence: [{ text: "근거", quote: sentence }], critique: "", unresolved: [], interests: "확인되지 않음", significance: "출발점", foundations: [], statusSignals: [], cautions: [] });
        },
      },
    });
    const g = engine.create({ projectId: f.projectId, collectionId: f.collectionId, title: "장애", settings: f.settings({ concurrency: 1, routes: { light: { provider: "claude", model: "" }, cards: { provider: "claude", model: "" }, write: { provider: "claude", model: "" } } }) });
    engine.start(g.id, "cards", false);
    const failed = await settle(engine, g.id);
    expect(failed.job).toMatchObject({ status: "failed", step: "cards" });
    expect(failed.completed.cards).toBeUndefined();
    // One paper was tried (three times), none was written off.
    expect(calls).toBe(3);
    expect(f.store.papers(g.id).map((p) => p.cardStatus)).toEqual(["none", "none", "none"]);

    up = true;
    engine.start(g.id, "cards", false);
    const done = await settle(engine, g.id);
    expect(done.job).toMatchObject({ status: "completed", step: "cards" });
    expect(f.store.papers(g.id).map((p) => p.cardStatus)).toEqual(["done", "done", "done"]);
    expect(f.store.papers(g.id).filter((p) => p.cardStatus === "failed")).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 30000);
