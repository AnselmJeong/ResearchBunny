// Evidence tables ("근거 표"): one row per paper, one column per thing to find
// (design, sample, findings, …). Every cell keeps its value, the words it was
// read from and their page. A cell whose quote is not in the text, or whose
// numbers are not in its quote, is left empty and marked, never filled in.

import type { ScreeningPurpose } from "./screening";

export interface EvidenceColumn {
  id: string;
  name: string;
  /** What to look for, one line; the model and the passage search read it. */
  seek: string;
  /** English keywords for finding the passages in a paper's text. */
  query: string;
}
export interface EvidenceTableConfig {
  projectId: string;
  columns: EvidenceColumn[];
  /** Goes up when a column is added, removed or redefined; rows filled before show as stale. */
  version: number;
  updatedAt: string;
}

const column = (id: string, name: string, seek: string, query: string): EvidenceColumn => ({ id, name, seek, query });
export const DEFAULT_COLUMNS: Record<ScreeningPurpose, EvidenceColumn[]> = {
  genealogy: [
    column("problem", "문제의식", "저자들이 무엇을 문제로 보았는가", "problem question gap unknown remains unclear aim"),
    column("claim", "주장", "가설, 정의, 핵심 주장", "hypothesis propose argue suggest model theory claim"),
    column("position", "입장", "누구의 주장을 지지하거나 반박하는가, 학파·계열", "contrast previous studies consistent with refute challenge debate"),
    column("open", "미해결 문제", "논문이 남긴 열린 질문", "future research remains unknown limitation further studies needed"),
  ],
  original: [
    column("design", "설계", "연구 설계(무작위 대조, 코호트, 단면, 증례 등)와 비교군", "study design randomized controlled trial cohort cross-sectional methods"),
    column("sample", "표본", "대상자 수(n)와 대상의 특성", "participants patients sample size n enrolled recruited inclusion criteria"),
    column("findings", "결과", "주요 결과", "results showed significantly found outcome primary endpoint"),
    column("effect", "효과 크기", "효과 크기, 오즈비, 차이 등 수치와 신뢰구간", "effect size odds ratio hazard ratio mean difference confidence interval p"),
    column("limits", "한계", "저자가 밝힌 한계", "limitations limitation small sample bias generalizability"),
  ],
  custom: [
    column("question", "연구 질문", "논문이 답하려는 질문", "aim objective we investigated whether question"),
    column("design", "설계", "연구 설계와 비교군", "study design randomized controlled trial cohort cross-sectional methods"),
    column("sample", "표본", "대상자 수(n)와 대상의 특성", "participants patients sample size n enrolled recruited"),
    column("findings", "주요 결과", "주요 결과", "results showed significantly found outcome"),
    column("effect", "효과 크기", "효과 크기와 신뢰구간", "effect size odds ratio hazard ratio mean difference confidence interval"),
    column("limits", "한계", "저자가 밝힌 한계", "limitations limitation small sample bias"),
  ],
};

export type CellStatus = "ok" | "not-reported" | "quote-missing" | "number-missing";
export const CELL_STATUS: Record<CellStatus, string> = {
  ok: "확인됨",
  "not-reported": "보고 없음",
  "quote-missing": "인용문이 원문에 없어 비움",
  "number-missing": "수치가 인용문에 없어 비움",
};
export interface EvidenceCell {
  /** Empty when the text does not report it or the value failed a check. */
  value: string;
  quote: string;
  /** 1-based PDF pages of the passage the quote is from; null for an abstract. */
  page: number | null;
  pageEnd: number | null;
  section: string;
  passageId: number | null;
  attachmentId: string | null;
  status: CellStatus;
  /** What a failed check threw away, so the person can look. */
  rejected?: string;
}
export interface EvidenceRow {
  workId: string;
  cells: Record<string, EvidenceCell>;
  /** "abstract": no indexed PDF, so the cells come from the abstract and are filled again once one is. */
  basis: "fulltext" | "abstract";
  columnsVersion: number;
  model: string;
  filledAt: string;
  error?: string;
}
export interface EvidenceRowView extends EvidenceRow {
  title: string;
  authors: string[];
  year: number | null;
  stale: boolean;
}
export interface EvidenceJob {
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  message: string;
  done: number;
  total: number;
  updatedAt: string;
}
export interface EvidenceTableView {
  config: EvidenceTableConfig;
  rows: EvidenceRowView[];
  /** Papers in scope without a row. */
  missing: { workId: string; title: string; year: number | null }[];
  job: EvidenceJob | null;
}

/** Numbers as they are written, so "12" in a value must appear in the quote. */
export const numbersIn = (text: string) => text.match(/\d+(?:[.,]\d+)?/g) ?? [];

/** The table as Markdown, one row per paper. */
export function evidenceMarkdown(view: Pick<EvidenceTableView, "config" | "rows">, title = "근거 표"): string {
  const escape = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const head = ["논문", ...view.config.columns.map((c) => c.name)];
  const lines = [`# ${title}`, "", `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const row of view.rows) {
    const who = `${row.authors[0]?.split(",")[0] || "저자 미상"}${row.authors.length > 1 ? " 외" : ""} ${row.year ?? "연도 미상"}`;
    const cells = view.config.columns.map((c) => {
      const cell = row.cells[c.id];
      if (!cell || !cell.value) return cell ? `(${CELL_STATUS[cell.status]})` : "";
      return `${escape(cell.value)}${cell.page ? ` (p. ${cell.page})` : ""}`;
    });
    lines.push(`| ${escape(`${who}, ${row.title}`)}${row.basis === "abstract" ? " [초록 기반]" : ""} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}

/** The table as CSV in long form: one line per cell. */
export function evidenceCsv(view: Pick<EvidenceTableView, "config" | "rows">, citekeys: Record<string, string> = {}): string {
  const quote = (text: string | number | null) => {
    const s = text === null ? "" : String(text);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ["work_id,citekey,title,year,basis,column,value,quote,page,page_end,section,status"];
  for (const row of view.rows)
    for (const c of view.config.columns) {
      const cell = row.cells[c.id];
      if (!cell) continue;
      lines.push([row.workId, citekeys[row.workId] ?? "", row.title, row.year, row.basis, c.name, cell.value, cell.quote, cell.page, cell.pageEnd, cell.section, cell.status].map(quote).join(","));
    }
  return lines.join("\n") + "\n";
}
