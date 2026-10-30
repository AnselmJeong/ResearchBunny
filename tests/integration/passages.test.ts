import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../../src/service/service";
import { extractPdfLines } from "../../src/service/interchange/pdf";
import { chunk, split } from "../../src/service/passages/chunker";
import { openPassageStore, PassageStore, quantize } from "../../src/service/passages/store";
import { PassageIndexer } from "../../src/service/passages/indexer";
import { normalize } from "../../src/service/providers/ollama-local";
import { SHELF_ALL } from "../../src/shared/shelf";
import type { PassageAnswer, PassageJob } from "../../src/shared/passages";
import { checkedNumbers, quoteIn } from "../../src/service/passages/answer";
import { DEFAULT_AI } from "../../src/service/providers/openai";
import type { AppEvent, Run as LibraryRun } from "../../src/shared/types";
import type { Page } from "../../src/service/providers/openalex";
import { fakeOllama } from "./shelf-helpers";

const worker = resolve("dist/runtime/pdf-worker.cjs");

type Run = { text: string; x?: number; y: number; size?: number; rotated?: boolean };
/** A multi-page PDF with text placed line by line, so layout rules (heads, folios, headings, columns) can be tested. */
async function layoutPdf(path: string, pages: Run[][]) {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: number[] = [];
  for (const runs of pages) {
    const stream = runs.map((r) => {
      const escaped = r.text.replace(/[()\\]/g, "");
      const matrix = r.rotated ? `0 1 -1 0 ${r.x ?? 580} ${r.y}` : `1 0 0 1 ${r.x ?? 60} ${r.y}`;
      return `BT /F1 ${r.size ?? 10} Tf ${matrix} Tm (${escaped}) Tj ET`;
    }).join("\n");
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const content = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, out);
}
/** Body lines from y downward, 12 points apart; the last line of each paragraph is short. */
function body(y: number, paragraphs: string[][]): Run[] {
  const runs: Run[] = [];
  for (const lines of paragraphs) {
    for (const text of lines) {
      runs.push({ text, y });
      y -= 12;
    }
    y -= 4;
  }
  return runs;
}
const frame = (page: number): Run[] => [
  { text: "Journal of Layout Tests 12 (2024) 100-120", y: 760, size: 8 },
  { text: String(page), y: 30, x: 300, size: 8 },
  { text: "Downloaded from example.org on 1 May 2024", y: 200, rotated: true, size: 7 },
];
const filler = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `The ${topic} measurement ${i + 1} was recorded across the cohort with the standard protocol and stable timing,`);

async function paper(path: string, topic: string, key: string) {
  await layoutPdf(path, [
    [
      ...frame(1),
      { text: `A layout study of ${topic}`, y: 700, size: 16 },
      { text: "Abstract", y: 660, size: 10 },
      ...body(645, [[`We report how ${topic} relates to ${key} in a small cohort.`, "Effects were modest but consistent across sites."]]),
      { text: "1. Introduction", y: 600, size: 10 },
      ...body(585, [[...filler(topic, 6), "and the paragraph continues on the next page with"]]),
    ],
    [
      ...frame(2),
      ...body(720, [["more detail about the baseline condition of every participant.", "This sentence closes the introduction."]]),
      { text: "2. Methods", y: 680, size: 10 },
      ...body(665, [[`Participants received a neuro-`, `transmitter assay for ${key} after fasting.`, "Samples were frozen at minus eighty degrees."], filler(`${topic} protocol`, 5)]),
    ],
    [
      ...frame(3),
      { text: "Acknowledgements", y: 720, size: 10 },
      ...body(705, [["We thank the funding body for generous secret support."]]),
      { text: "References", y: 660, size: 10 },
      ...body(645, [["1. Author A. Some reference title about nothing. J Test. 2001;1:1-2."]]),
    ],
    [...frame(4), ...body(720, [["2. Author B. Another reference entry. J Test. 2002;2:3-4."]])],
  ]);
}

test("PDF layout becomes paragraphs and passages with pages and sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-passages-"));
  try {
    const path = join(root, "layout.pdf");
    await paper(path, "sleep spindles", "melatonin");
    const lines = await extractPdfLines(path, worker, AbortSignal.timeout(30000));
    expect(lines?.total).toBe(4);
    const result = split(lines!);
    expect(result.referencesExcluded).toBe(true);
    const text = result.chunks.map((c) => c.text).join("\n");
    // Running heads, folios, side stamps, back matter and references stay out.
    expect(text).not.toContain("Journal of Layout Tests");
    expect(text).not.toContain("Downloaded from");
    expect(text).not.toContain("secret support");
    expect(text).not.toContain("Another reference entry");
    expect(text).not.toMatch(/(^|\n)\d+(\n|$)/);
    // A hyphen at a line end joins the word; a paragraph runs on across a page break.
    expect(text).toContain("neurotransmitter assay for melatonin");
    expect(text).toContain("continues on the next page with more detail about the baseline");
    const methods = result.chunks.find((c) => c.text.includes("neurotransmitter"))!;
    expect(methods.section).toBe("2. Methods");
    expect(methods.pageStart).toBe(2);
    expect(result.chunks.find((c) => c.text.includes("baseline condition"))!.section).toBe("1. Introduction");
    expect(result.chunks.every((c) => c.text.length <= 2000)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunks pack paragraphs, split long ones at sentences and keep a section's tail with it", () => {
  const sentence = (n: number) => `Sentence number ${n} describes a finding in reasonable detail for the reader.`;
  const long = Array.from({ length: 60 }, (_, i) => sentence(i)).join(" ");
  const chunks = chunk([
    { text: "Short intro paragraph about the aims of the study and why it matters.", page: 1, section: "Introduction" },
    { text: long, page: 2, section: "Results" },
    { text: "A short tail of the results section.", page: 3, section: "Results" },
    { text: Array.from({ length: 12 }, (_, i) => sentence(100 + i)).join(" "), page: 3, section: "Discussion" },
  ]);
  expect(chunks.every((c) => c.text.length <= 2000)).toBe(true);
  expect(chunks.filter((c) => c.section === "Results").length).toBeGreaterThan(1);
  // Long paragraphs break between sentences, not inside them.
  expect(chunks.filter((c) => c.section === "Results").every((c) => /\.$/.test(c.text.trim()))).toBe(true);
  expect(chunks.find((c) => c.text.includes("short tail"))!.section).toBe("Results");
  expect(chunks.at(-1)!.section).toBe("Discussion");
  expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
});

test("the store scores int8 vectors exactly after the sign-bit scan, within a scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-passage-store-"));
  const store = new PassageStore(join(root, "passages.sqlite"));
  try {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const vectors = new Map<number, Float32Array>();
    for (let d = 0; d < 20; d++) {
      store.saveDoc(`hash${d}`, "c1", `Paper ${d}`, { chunks: Array.from({ length: 10 }, (_, i) => ({ seq: i, text: `paper ${d} passage ${i}`, pageStart: 1, pageEnd: 1, section: "" })), chars: 100, referencesExcluded: false, pages: 1 });
    }
    const pending = store.pending("m", 0, 1000);
    expect(pending).toHaveLength(200);
    store.saveVectors("m", pending.map((p) => {
      const vector = normalize(Array.from({ length: 768 }, random));
      vectors.set(p.id, vector);
      return { id: p.id, vector };
    }));
    expect(store.pending("m", 0, 10)).toHaveLength(0);
    // A new model leaves every passage pending again.
    expect(store.pending("other", 0, 1000)).toHaveLength(200);
    const { scale, data } = quantize(vectors.get(pending[0].id)!);
    const back = new Int8Array(data.buffer).map((v) => v);
    expect(Math.max(...[...vectors.get(pending[0].id)!].map((v, i) => Math.abs(v - back[i] * scale)))).toBeLessThan(scale);

    const query = normalize(Array.from({ length: 768 }, random));
    const exact = [...vectors].map(([id, v]) => ({ id, score: v.reduce((n, x, i) => n + x * query[i], 0) })).sort((a, b) => b.score - a.score);
    const found = store.semantic("m", query, 5, () => true, 1000);
    expect(found.map((h) => h.id)).toEqual(exact.slice(0, 5).map((h) => h.id));
    expect(Math.abs(found[0].score - exact[0].score)).toBeLessThan(0.01);
    const scope = new Set(store.idsOf(["hash3", "hash4"]));
    const scoped = store.semantic("m", query, 5, (id) => scope.has(id), 1000);
    expect(scoped.map((h) => h.id)).toEqual(exact.filter((h) => scope.has(h.id)).slice(0, 5).map((h) => h.id));

    // A damaged index file is set aside; indexing starts over instead of failing.
    const broken = join(root, "broken.sqlite");
    await writeFile(broken, "not a database ".repeat(400));
    const fresh = openPassageStore(broken);
    expect(fresh.counts(null).docs).toBe(0);
    fresh.close();

    store.deleteDocs(["hash3"]);
    expect(store.counts("m")).toMatchObject({ ok: 19, passages: 190, embedded: 190 });
    expect(store.semantic("m", query, 200, () => true, 1000).some((h) => scope.has(h.id) && store.idsOf(["hash4"]).indexOf(h.id) < 0)).toBe(false);
    expect(store.lexical('"passage" AND "paper"', 3)).toHaveLength(3);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the app indexes shelf passages after a scan and searches them by words and meaning", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-passage-app-"));
  const dir = join(root, "Articles");
  await paper(join(dir, "01 Sleep/2024 - Lee et al. - Sleep spindles and memory.pdf"), "sleep spindles", "melatonin");
  await paper(join(dir, "02 Mood/2023 - Park - Ketamine response in depression.pdf"), "ketamine response", "glutamate");
  await paper(join(dir, "2022 - Choi - Gut microbiota and anxiety.pdf"), "gut microbiota", "butyrate");
  const jobs: PassageJob[] = [];
  const service = new Service(join(root, "library"), worker, (event) => { if (event.type === "passages") jobs.push(event.job); });
  const ollama = fakeOllama();
  const empty = (): Page => ({ works: [], cursor: null, total: 0, cached: false, fetchedAt: new Date().toISOString() });
  service.oa.page = async (_p: Record<string, string>, _s: AbortSignal, onCall: () => void) => (onCall(), empty());
  service.oa.lookup = async () => { throw new Error("not found"); };
  try {
    const projectId = service.db.projects()[0].id;
    await service.call("shelfConfigure", { path: dir, ollamaUrl: ollama.url });
    await service.shelf.wait();
    // The app starts a pass after each scan once the shelf runs on its timer; here it is started by hand.
    await service.passages.run();
    const status = await service.call("passageStatus", {}) as Awaited<ReturnType<PassageIndexer["status"]>>;
    expect(status.job.docs).toEqual({ done: 3, total: 3 });
    expect(status.job.passages.done).toBe(status.job.passages.total);
    expect(status.job.passages.total).toBeGreaterThanOrEqual(6);
    expect(jobs.some((j) => j.state === "running")).toBe(true);

    // A word only in the Methods body finds that passage, its page and section.
    const found = await service.passageSearch.search("butyrate assay fasting", { limit: 10, revision: String(service.shelf.revision) });
    expect(found.semantic).toBe(true);
    expect(found.hits[0].title).toContain("Gut microbiota");
    expect(found.hits[0].page).toBe(2);
    expect(found.hits[0].section).toBe("2. Methods");
    expect(found.terms).toContain("butyrate");
    expect(found.coverage).toMatchObject({ docs: 3, total: 3 });
    // One word out of four is not a word match.
    const loose = await service.passageSearch.search("butyrate zebra quantum harbor", { limit: 10, revision: String(service.shelf.revision) });
    expect(loose.hits.every((h) => h.lexicalRank === null)).toBe(true);
    expect((await service.passageSearch.search("butyrate zebra", { limit: 10, revision: String(service.shelf.revision) })).hits[0].lexicalRank).toBe(1);
    // A folder limits the search to its papers.
    const folder = service.db.db.prepare("SELECT id FROM shelf_folders WHERE rel_path='02 Mood'").get() as { id: string };
    const scoped = await service.call("passageSearch", { projectId, query: "butyrate glutamate assay", folderId: folder.id }) as typeof found;
    expect(scoped.hits.length).toBeGreaterThan(0);
    expect(scoped.hits.every((h) => h.title.includes("Ketamine"))).toBe(true);
    const all = await service.call("passageSearch", { projectId, query: "assay", folderId: SHELF_ALL }) as typeof found;
    expect(new Set(all.hits.map((h) => h.workId)).size).toBe(3);

    // A PDF the app no longer shows loses its passages on the next pass; nothing is extracted twice.
    service.db.db.prepare("UPDATE shelf_files SET status='hidden' WHERE rel_path LIKE '2022 - Choi%'").run();
    const before = service.passageStore.counts(null).ok;
    await service.passages.run();
    expect(service.passageStore.counts(null).ok).toBe(before - 1);
    const after = await service.passageSearch.search("butyrate", { limit: 10, revision: "hidden" });
    expect(after.hits.some((h) => h.title.includes("Gut microbiota"))).toBe(false);

    // Once the shelf runs on its timer, a scan that finds a new PDF is followed by a passage pass.
    await paper(join(dir, "02 Mood/2025 - Han - Lithium and circadian clocks.pdf"), "lithium dosing", "circadian");
    service.shelf.start();
    await service.shelf.scan("test");
    await service.passages.wait();
    expect(service.passages.job.docs).toEqual({ done: 3, total: 3 });
    expect((await service.passageSearch.search("lithium circadian", { limit: 5, revision: "new" })).hits[0].title).toContain("Lithium");

    // Another process holding the index makes the app wait instead of indexing twice.
    service.passageStore.setMeta("owner", { id: "someone-else", at: Date.now(), pid: 1 });
    await service.passages.run();
    expect(service.passages.job.state).toBe("waiting");
    service.passageStore.db.prepare("DELETE FROM meta WHERE key='owner'").run();

    await service.call("passageControl", { action: "pause" });
    expect(service.passages.job.state).toBe("paused");
    await service.passages.run();
    expect(service.passages.job.state).toBe("paused");
    await service.call("passageControl", { action: "resume" });
    await service.passages.wait();
    expect(service.passages.paused()).toBe(false);
  } finally {
    service.shelf.stop();
    service.passages.stop();
    await service.shelf.wait();
    await service.passages.wait();
    service.downloads.stopRecoveryMonitor();
    ollama.stop();
    service.passageStore.close();
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a quote counts when its passage holds it, with folding and ellipses but not paraphrase", () => {
  const text = "Participants received a neurotransmitter assay for butyrate after fasting. Samples were \u201cfrozen\u201d at minus eighty degrees \u2013 then thawed.";
  expect(quoteIn("Participants received a neurotransmitter assay", text)).toBe(true);
  expect(quoteIn("  SAMPLES were \"frozen\" at minus eighty degrees - then thawed.", text)).toBe(true);
  expect(quoteIn("Participants received a neurotransmitter assay … frozen\" at minus eighty", text)).toBe(true);
  expect(quoteIn("frozen\" at minus eighty … Participants received a neurotransmitter assay", text)).toBe(false);
  expect(quoteIn("Participants were given a neurotransmitter assay", text)).toBe(false);
  expect(quoteIn("butyrate", text)).toBe(false);
  expect(checkedNumbers("세 연구 중 2개, 효과 0.42, 반응률 37%, 2019년")).toEqual(["0.42", "37", "2019"]);
});

test("answers cite passages by number, keep only quotes found in them, and can be cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-passage-answer-"));
  const dir = join(root, "Articles");
  await paper(join(dir, "02 Mood/2023 - Park - Ketamine response in depression.pdf"), "ketamine response", "glutamate");
  await paper(join(dir, "2022 - Choi - Gut microbiota and anxiety.pdf"), "gut microbiota", "butyrate");
  const events: AppEvent[] = [];
  const service = new Service(join(root, "library"), worker, (event) => events.push(event));
  const ollama = fakeOllama();
  const empty = (): Page => ({ works: [], cursor: null, total: 0, cached: false, fetchedAt: new Date().toISOString() });
  service.oa.page = async (_p: Record<string, string>, _s: AbortSignal, onCall: () => void) => (onCall(), empty());
  service.oa.lookup = async () => { throw new Error("not found"); };
  try {
    const projectId = service.db.projects()[0].id;
    await service.call("shelfConfigure", { path: dir, ollamaUrl: ollama.url });
    await service.shelf.wait();
    await service.passages.run();
    const question = "금식 후 butyrate는 어떻게 측정했나?";

    await expect(service.call("passageAsk", { projectId, question, askId: crypto.randomUUID() })).rejects.toThrow("AI 연결");
    service.db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: true, aiMaxInputTokens: 100000 });

    const calls: { name: string; data: any }[] = [];
    service.ai.structured = async (_run: LibraryRun, name: string, _schema: Record<string, unknown>, _instruction: string, data: unknown) => {
      calls.push({ name, data });
      if (name === "passage_plan") return { queries: ["butyrate assay after fasting", "frozen samples storage temperature"] };
      const evidence = (data as { evidence: { n: number; text: string }[] }).evidence;
      const methods = evidence.find((e) => e.text.includes("assay for butyrate after fasting"))!;
      return {
        statements: [
          { text: "장내 미생물 연구는 금식 후 butyrate를 측정했다.", sources: [{ n: methods.n, quote: "neurotransmitter assay for butyrate after fasting" }], paragraph: false },
          { text: "샘플은 영하 80도에 얼렸다.", sources: [{ n: methods.n, quote: "Samples were frozen at minus eighty degrees." }], paragraph: false },
          { text: "효과 크기는 0.42였다.", sources: [{ n: methods.n, quote: "Participants received a neurotransmitter assay" }], paragraph: true },
          { text: "근거 없는 주장이다.", sources: [{ n: methods.n, quote: "this sentence is nowhere in the passage text" }], paragraph: false },
          { text: "없는 구절 번호를 인용했다.", sources: [{ n: 99, quote: "whatever text that is long enough to check" }], paragraph: false },
          { text: "요약하면 금식 후 측정했다.", sources: [], paragraph: true },
        ],
        insufficient: false,
        missing: "",
      };
    };
    const askId = crypto.randomUUID();
    const answer = await service.call("passageAsk", { projectId, question, askId }) as PassageAnswer;
    expect(calls.map((c) => c.name)).toEqual(["passage_plan", "passage_answer"]);
    expect(answer.queries).toEqual([question, "butyrate assay after fasting", "frozen samples storage temperature"]);
    // Passages go to the AI numbered, at most three per paper.
    const sent = calls[1].data.evidence as { n: number; paper: string; pages: string }[];
    expect(sent.map((e) => e.n)).toEqual(sent.map((_, i) => i + 1));
    const perPaper = new Map<string, number>();
    for (const e of sent) perPaper.set(e.paper, (perPaper.get(e.paper) || 0) + 1);
    expect(Math.max(...perPaper.values())).toBeLessThanOrEqual(3);
    expect(sent.some((e) => e.paper.includes("Gut microbiota"))).toBe(true);

    expect(answer.statements.map((s) => s.status)).toEqual(["cited", "cited", "cited", "unverified", "unverified", "uncited"]);
    expect(answer.statements[0].refs).toEqual([1]);
    expect(answer.refs).toHaveLength(1);
    expect(answer.refs[0].hit.title).toContain("Gut microbiota");
    expect(answer.refs[0].hit.page).toBe(2);
    expect(answer.refs[0].hit.section).toBe("2. Methods");
    expect(answer.refs[0].quotes).toContain("Samples were frozen at minus eighty degrees.");
    // Numbers must appear in a cited passage: 0.42 is in none, and the passage spells out "eighty", so 80 is flagged too.
    expect(answer.statements[2].unsupported).toEqual(["0.42"]);
    expect(answer.statements[1].unsupported).toEqual(["80"]);
    expect(answer.dropped).toBe(2);
    expect(answer.unused.every((h) => h.passageId !== answer.refs[0].hit.passageId)).toBe(true);
    expect(answer.unused.length).toBe(sent.length - 1);
    expect(events.filter((e) => e.type === "answer" && e.id === askId).map((e) => e.type === "answer" && e.step)).toEqual(["plan", "search", "write", "check"]);

    // The same question comes from memory; asking afresh calls the AI again.
    expect((await service.call("passageAsk", { projectId, question, askId: crypto.randomUUID() }) as PassageAnswer).createdAt).toBe(answer.createdAt);
    expect(calls).toHaveLength(2);
    await service.call("passageAsk", { projectId, question, askId: crypto.randomUUID(), fresh: true });
    expect(calls).toHaveLength(4);

    // A plan the AI gets wrong falls back to the question alone.
    service.ai.structured = async (_run: LibraryRun, name: string) => {
      if (name === "passage_plan") return { wrong: true };
      return { statements: [{ text: "근거가 부족하다.", sources: [], paragraph: false }], insufficient: true, missing: "측정 방법을 다룬 구절이 없다." };
    };
    const thin = await service.call("passageAsk", { projectId, question: "butyrate fasting", askId: crypto.randomUUID() }) as PassageAnswer;
    expect(thin.queries).toEqual(["butyrate fasting"]);
    expect(thin.insufficient).toBe(true);
    expect(thin.missing).toBe("측정 방법을 다룬 구절이 없다.");

    // Cancelling stops the request where it waits for the AI.
    service.ai.structured = (_run: LibraryRun, _name: string, _schema: Record<string, unknown>, _instruction: string, _data: unknown, signal: AbortSignal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const slow = crypto.randomUUID();
    const pending = service.call("passageAsk", { projectId, question: "ketamine glutamate response", askId: slow });
    await Bun.sleep(30);
    expect(service.answers.active.has(slow)).toBe(true);
    await service.call("passageAskCancel", { askId: slow });
    await expect(pending).rejects.toThrow("취소");
    expect(service.answers.active.size).toBe(0);
  } finally {
    service.shelf.stop();
    service.passages.stop();
    await service.shelf.wait();
    await service.passages.wait();
    service.downloads.stopRecoveryMonitor();
    ollama.stop();
    service.passageStore.close();
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
