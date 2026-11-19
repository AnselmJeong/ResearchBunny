import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import { EvidenceTables, checkCell, fillRow } from "../../src/service/evidence";
import { DEFAULT_COLUMNS, evidenceCsv, evidenceMarkdown } from "../../src/shared/evidence";
import type { PassageHit } from "../../src/shared/passages";
import type { JsonRequest } from "../../src/service/genealogy/llm";

const hit = (passageId: number, text: string, page = 3): PassageHit => ({
  passageId, workId: "w", fileId: "f", attachmentId: "a1", title: "T", authors: [], year: 2020, folder: "", page, pageEnd: page, section: "Methods", text, score: 1, lexicalRank: 1, semanticRank: null,
});
const METHODS = "We randomised 120 patients with treatment-resistant schizophrenia to aripiprazole or placebo for 12 weeks.";
const RESULTS = "PANSS total scores fell by 8.4 points more with aripiprazole (95% CI 3.1 to 13.7).";
const columns = DEFAULT_COLUMNS.original.slice(0, 3);
const ai = (cells: (input: { sources: { id: string; text: string }[] }) => { column: string; value: string; quote: string; ref: string }[]) => {
  const calls: { instruction: string; input: { sources: { id: string; text: string; page?: number }[] } }[] = [];
  return {
    calls,
    async json<T>(request: JsonRequest<T>): Promise<T> {
      let attempt = 0;
      for (;;) {
        const input = JSON.parse(request.input);
        calls.push({ instruction: request.instruction, input });
        try {
          return request.parse({ cells: cells(input) }, attempt);
        } catch (error) {
          if (attempt++ === 1) throw error;
        }
      }
    },
  };
};
const route = { provider: "codex" as const, model: "" };

test("cells keep their quote and page; a quote not in the source or a loose number empties the cell", () => {
  const refs = new Map([["S1", { ref: "S1", text: METHODS, hit: hit(11, METHODS, 4) }]]);
  const ok = checkCell({ value: "무작위 대조 시험, 120명", quote: "We randomised 120 patients", ref: "S1" }, refs);
  assert.equal(ok.status, "ok");
  assert.equal(ok.page, 4);
  assert.equal(ok.attachmentId, "a1");
  const invented = checkCell({ value: "무작위 대조 시험", quote: "We enrolled patients in a double-blind trial", ref: "S1" }, refs);
  assert.equal(invented.status, "quote-missing");
  assert.equal(invented.value, "");
  assert.equal(invented.rejected, "무작위 대조 시험");
  const loose = checkCell({ value: "환자 150명", quote: "We randomised 120 patients", ref: "S1" }, refs);
  assert.equal(loose.status, "number-missing");
  assert.equal(checkCell({ value: "", quote: "", ref: "none" }, refs).status, "not-reported");
});

test("a row is read from the paper's passages, one call per paper", async () => {
  const searched: string[] = [];
  const model = ai((input) => {
    const s = (needle: string) => input.sources.find((x) => x.text.includes(needle))!.id;
    return [
      { column: "design", value: "무작위 대조 시험", quote: "We randomised 120 patients", ref: s("randomised") },
      { column: "sample", value: "치료 저항성 조현병 환자 120명", quote: "120 patients with treatment-resistant schizophrenia", ref: s("randomised") },
      { column: "findings", value: "PANSS 8.4점 더 감소", quote: "PANSS total scores fell by 8.4 points more", ref: s("PANSS") },
    ];
  });
  const row = await fillRow(
    { ai: model, route, runId: "t", search: async (query) => { searched.push(query); return query.includes("results") ? [hit(12, RESULTS, 6)] : [hit(11, METHODS, 4)]; } },
    { work: blankWork({ id: "w", title: "Trial", abstract: "abstract" }), columns, question: "q", columnsVersion: 2, signal: AbortSignal.timeout(5000) },
  );
  assert.equal(searched.length, 3);
  assert.equal(model.calls.length, 1);
  // The same passage found for two columns is sent once.
  assert.equal(model.calls[0].input.sources.length, 2);
  assert.equal(row.basis, "fulltext");
  assert.equal(row.columnsVersion, 2);
  assert.equal(row.cells.findings.page, 6);
  assert.equal(row.cells.sample.status, "ok");
});

test("without an indexed PDF the row comes from the abstract; a model that will not copy is asked once more", async () => {
  const abstract = "In this open-label study 12 patients received clozapine augmentation; symptoms improved.";
  let call = 0;
  const model = ai(() =>
    ++call === 1
      ? [
          { column: "design", value: "공개 연구", quote: "an invented sentence about the design", ref: "A" },
          { column: "sample", value: "12명", quote: "twelve patients improved a lot", ref: "A" },
          { column: "findings", value: "증상 호전", quote: "symptoms got far better", ref: "A" },
        ]
      : [
          { column: "design", value: "공개 연구", quote: "In this open-label study", ref: "A" },
          { column: "sample", value: "12명", quote: "12 patients received clozapine augmentation", ref: "A" },
          { column: "findings", value: "증상 호전", quote: "symptoms improved", ref: "A" },
        ],
  );
  const row = await fillRow(
    { ai: model, route, runId: "t", search: async () => [] },
    { work: blankWork({ id: "w", title: "Open study", abstract }), columns, question: "q", columnsVersion: 1, signal: AbortSignal.timeout(5000) },
  );
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[0].instruction, /evidence table/);
  assert.equal(row.basis, "abstract");
  assert.equal(row.cells.sample.value, "12명");
  assert.equal(row.cells.sample.page, null);
  await assert.rejects(
    fillRow({ ai: model, route, runId: "t", search: async () => [] }, { work: blankWork({ id: "x", abstract: null }), columns, question: "q", columnsVersion: 1, signal: AbortSignal.timeout(5000) }),
    /색인된 PDF도 초록도 없어/,
  );
});

test("a fill job saves rows, marks them stale when columns change, and exports CSV and Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-evidence-"));
  const db = new Library(join(root, "library"));
  try {
    const projectId = db.projects()[0].id;
    const ids = [1, 2].map((n) => {
      const { work } = db.upsert(blankWork({ title: `Trial ${n}`, doi: `10.5/${n}`, year: 2020 + n, authors: ["Kim, J", "Lee, S"], abstract: `We randomised ${n * 10} patients to drug or placebo.` }));
      db.mutate(projectId, [work.id], { screening: "included" });
      return work.id;
    });
    const model = ai((input) => [
      { column: "design", value: "무작위 대조 시험", quote: "We randomised", ref: input.sources[0].id },
      { column: "sample", value: "", quote: "", ref: "none" },
      { column: "findings", value: "", quote: "", ref: "none" },
    ]);
    const events: string[] = [];
    const tables = new EvidenceTables({ db, ai: model, route: () => route, purpose: () => "original", search: async () => [], emit: (e) => events.push(e.type) });
    // The first fill keeps the purpose's default columns.
    const defaults = new EvidenceTables({ db, ai: model, route: () => route, purpose: () => "genealogy", search: async () => [], emit: () => {} });
    assert.equal(defaults.store.hasConfig(projectId), false);
    tables.store.saveColumns(projectId, columns);
    tables.start(projectId, { kind: "archive" });
    for (let i = 0; i < 1000 && tables.active.size; i++) await Bun.sleep(2);
    let view = tables.view(projectId, { kind: "archive" });
    assert.equal(view.job?.status, "completed", view.job?.message ?? "");
    assert.equal(view.rows.length, 2);
    assert.equal(view.rows[0].cells.design.value, "무작위 대조 시험");
    assert.equal(view.rows[0].cells.sample.status, "not-reported");
    assert.equal(view.rows[0].basis, "abstract");
    assert(events.includes("changed"));
    // Abstract-only rows are filled again on the next run, waiting for a PDF.
    assert.doesNotThrow(() => tables.start(projectId, { kind: "ids", ids: [ids[0]] }));
    for (let i = 0; i < 1000 && tables.active.size; i++) await Bun.sleep(2);
    const csv = evidenceCsv(view, { [ids[0]]: "Kim2021Trial" });
    assert.match(csv.split("\n")[0], /^work_id,citekey,title,year,basis,column,value,quote,page/);
    assert.match(csv, /Kim2021Trial,Trial 1,2021,abstract,설계,무작위 대조 시험,We randomised,,/);
    const md = evidenceMarkdown(view);
    assert.match(md, /\| 논문 \| 설계 \| 표본 \| 결과 \|/);
    assert.match(md, /Kim 외 2021, Trial 1 \[초록 기반\] \| 무작위 대조 시험 \| \(보고 없음\)/);
    const path = join(root, "table.md");
    await tables.export(projectId, { kind: "archive" }, "md", path);
    assert.match(await readFile(path, "utf8"), /# 내 연구 근거 표/);
    // Redefining a column marks filled rows stale; renaming one does not.
    tables.store.saveColumns(projectId, columns.map((c) => (c.id === "design" ? { ...c, name: "연구 설계" } : c)));
    assert.equal(tables.view(projectId, { kind: "archive" }).rows[0].stale, false);
    tables.store.saveColumns(projectId, [...columns, { id: "dose", name: "용량", seek: "투여 용량", query: "dose mg" }]);
    view = tables.view(projectId, { kind: "archive" });
    assert.equal(view.rows[0].stale, true);
    assert.equal(view.config.columns.at(-1)!.name, "용량");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
