import type { PdfLine, PdfLines } from "../interchange/pdf";

/** Bump when paragraphs or chunks change: every PDF is split and embedded again. */
export const CHUNKER_VERSION = "c1";

export interface Paragraph {
  text: string;
  page: number;
  section: string;
}
export interface Chunk {
  seq: number;
  text: string;
  pageStart: number;
  pageEnd: number;
  section: string;
}
export interface Split {
  chunks: Chunk[];
  /** Characters kept for chunks; 0 means a scan or a PDF without a text layer. */
  chars: number;
  referencesExcluded: boolean;
  pages: number;
}

/** Chunk sizes in characters: about 250–450 tokens of English prose. */
const MIN = 700;
const TARGET = 1400;
const MAX = 2000;

const TERMINAL = /[.?!:]["'”’)\]]*$/;
const REFERENCES = /^(?:\d{1,2}\.?\s*)?(?:references(?:\s+(?:and|&)\s+notes)?|bibliography|literature cited|works cited|cited literature|참\s*고\s*문\s*헌)\s*[:.]?$/i;
/** Back matter that only adds noise to retrieval; skipped until the next heading. */
const BACK_MATTER = /^(?:\d{1,2}\.?\s*)?(?:acknowledge?ments?|funding(?: sources?| information)?|financial support|role of the funding source|conflicts? of interests?|competing interests?|declarations? of (?:competing )?interests?|disclosures?|author contributions?|credit authorship contribution statement|data (?:and code )?availability(?: statement)?|code availability|ethics (?:approval|statement|declarations?)|additional information|supplementary (?:materials?|information)|declaration of generative ai.*)\s*[:.]?$/i;
const NAMED_SECTION = /^(?:\d{1,2}(?:\.\d{1,2})*\.?\s+)?(?:abstract|summary|introduction|background|methods?|materials and methods|methods and materials|patients and methods|participants|results|findings|discussion|conclusions?|limitations|general discussion|concluding remarks)\s*[:.]?$/i;
const NUMBERED_HEADING = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVX]{1,5}\.)\s+\p{Lu}/u;
/** Publisher front matter on the first page, and bare links anywhere. */
const FRONT_NOISE = /^(?:journal homepage|contents lists available|received:?\s|revised:?\s|accepted:?\s|available online|published online|article history|e-?mail|corresponding author|citation:|copyright|©|open access|check for updates)/i;
const LINK_ONLY = /^(?:https?:\/\/|www\.|doi:\s*10\.)\S+$/i;
const MARGIN_NOISE = /downloaded from|for personal use only|all rights reserved|protected by copyright|creative commons|this is an open access article|^\s*(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?\s*$|^[–—-]\s*\d{1,4}\s*[–—-]$/i;

const letters = (text: string) => (text.match(/\p{L}/gu) || []).length;
const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
/** Running heads and folios share their wording on many pages; digits vary. */
const marginKey = (text: string) => text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, "");

interface Metrics {
  body: number;
  lead: number;
  width: number;
}
function metrics(pages: PdfLines["pages"]): Metrics {
  const sizes = new Map<number, number>();
  for (const page of pages) for (const line of page.lines) {
    const size = Math.round(line.h * 2) / 2;
    sizes.set(size, (sizes.get(size) || 0) + line.t.length);
  }
  const body = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const gaps: number[] = [];
  const widths: number[] = [];
  for (const page of pages)
    page.lines.forEach((line, i) => {
      if (Math.abs(line.h - body) > body * 0.15) return;
      if (line.t.length > 40) widths.push(line.w);
      const prev = page.lines[i - 1];
      if (prev && Math.abs(prev.h - body) <= body * 0.15 && Math.abs(prev.x - line.x) < body * 3) {
        const gap = prev.y - line.y;
        if (gap > body * 0.6 && gap < body * 3) gaps.push(gap);
      }
    });
  return { body, lead: median(gaps) || body * 1.2, width: median(widths) || 300 };
}

/** Lines repeated in the top or bottom margin of many pages (running heads, folios, download stamps). */
function marginLines(pages: PdfLines["pages"]): Set<PdfLine> {
  const drop = new Set<PdfLine>();
  const inMargin = (line: PdfLine, height: number) => line.y > height * 0.9 || line.y < height * 0.08;
  const counts = new Map<string, number>();
  for (const page of pages) {
    const keys = new Set(page.lines.filter((l) => inMargin(l, page.height)).map((l) => marginKey(l.t)));
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const repeated = Math.max(3, Math.ceil(pages.length * 0.25));
  for (const page of pages)
    for (const line of page.lines) {
      if (!inMargin(line, page.height)) continue;
      if (MARGIN_NOISE.test(line.t) || (pages.length >= 4 && (counts.get(marginKey(line.t)) || 0) >= repeated)) drop.add(line);
    }
  for (const page of pages) for (const line of page.lines) if (/downloaded from .*(?:on|by)/i.test(line.t)) drop.add(line);
  return drop;
}

function isHeading(line: PdfLine, next: PdfLine | undefined, m: Metrics) {
  const text = line.t;
  if (text.length > 160 || letters(text) < 3) return false;
  if (REFERENCES.test(text) || BACK_MATTER.test(text) || NAMED_SECTION.test(text)) return true;
  // Larger type is a heading only when body text follows; figure labels are followed by more labels.
  if (line.h >= m.body * 1.12 && text.length <= 150) return !!next && Math.abs(next.h - m.body) <= m.body * 0.08 && next.t.length >= 40;
  return NUMBERED_HEADING.test(text) && text.length <= 100 && !TERMINAL.test(text) && text.split(/\s+/).length <= 14 && line.w < m.width * 0.95;
}

/** "neuro-" + "transmitter" → "neurotransmitter"; other lines join with a space. */
function joinLines(lines: string[]) {
  let text = "";
  for (const line of lines) {
    if (!text) text = line;
    else if (/\p{Ll}-$/u.test(text) && /^\p{Ll}/u.test(line)) text = text.slice(0, -1) + line;
    else text += (text.endsWith("-") || text.endsWith("/") ? "" : " ") + line;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Paragraphs of a paper's body in reading order, with their page and section.
 * Running heads, folios and back matter are dropped; everything after the
 * references heading is cut once a quarter of the text has passed.
 */
export function paragraphs(doc: PdfLines): { paragraphs: Paragraph[]; referencesExcluded: boolean } {
  const m = metrics(doc.pages);
  const drop = marginLines(doc.pages);
  const total = doc.pages.reduce((n, p) => n + p.lines.reduce((k, l) => k + l.t.length, 0), 0);
  const out: Paragraph[] = [];
  let section = "";
  let skipping = false;
  let seen = 0;
  let current: { lines: string[]; page: number; size: number } | null = null;
  let prev: PdfLine | null = null;
  let prevHeading = false;
  const flush = () => {
    if (current && !skipping) {
      const text = joinLines(current.lines);
      // Tables of numbers, stray symbols and contents pages with dot leaders carry no prose.
      if (letters(text) >= 12 && letters(text) >= text.length * 0.3 && (text.match(/(?:\s?\.){5,}/g) || []).length < 3) out.push({ text, page: current.page, section });
    }
    current = null;
  };
  for (const [index, page] of doc.pages.entries()) {
    const pageNo = index + 1;
    let first = true;
    for (const [at, line] of page.lines.entries()) {
      if (drop.has(line) || LINK_ONLY.test(line.t) || (pageNo === 1 && FRONT_NOISE.test(line.t))) continue;
      seen += line.t.length;
      if (isHeading(line, page.lines[at + 1], m)) {
        flush();
        if (REFERENCES.test(line.t) && seen > total * 0.25) return { paragraphs: out, referencesExcluded: true };
        // The title, author list and journal banner break paragraphs but name no section.
        const named = pageNo > 1 || NAMED_SECTION.test(line.t) || NUMBERED_HEADING.test(line.t) || BACK_MATTER.test(line.t);
        // A heading wrapped over two lines is one heading.
        const wrapped = prevHeading && !first && prev && prev.y - line.y > 0 && prev.y - line.y < Math.max(prev.h, line.h) * 1.8 && Math.abs(prev.h - line.h) < 0.6;
        if (named) {
          section = wrapped ? `${section} ${line.t}`.slice(0, 160) : line.t;
          if (!wrapped) skipping = BACK_MATTER.test(line.t);
        }
        prev = line;
        prevHeading = true;
        first = false;
        continue;
      }
      prevHeading = false;
      let brk = !current;
      if (current && prev) {
        const size = Math.abs(line.h - current.size) > current.size * 0.08;
        const sameColumn = Math.abs(line.x - prev.x) < m.body * 6 && line.y < prev.y;
        const gap = prev.y - line.y;
        const ended = TERMINAL.test(prev.t);
        const short = prev.w < m.width * 0.8;
        const indent = line.x - prev.x > m.body * 0.6 && line.x - prev.x < m.width * 0.25;
        if (size) brk = true;
        else if (first || !sameColumn) brk = ended && (short || indent);
        else if (gap > m.lead * 1.6) brk = true;
        else brk = ended && (short || indent);
      }
      if (brk) {
        flush();
        current = { lines: [], page: pageNo, size: line.h };
      }
      current!.lines.push(line.t);
      prev = line;
      first = false;
    }
  }
  flush();
  return { paragraphs: out, referencesExcluded: false };
}

/** Sentences of an over-long paragraph, packed back into pieces near TARGET. */
function pieces(text: string): string[] {
  const sentences = text.split(/(?<=[.?!]["'”’)\]]?)\s+(?=[\p{Lu}(["“])/u);
  const out: string[] = [];
  let piece = "";
  for (const sentence of sentences) {
    if (piece && piece.length + sentence.length + 1 > TARGET) {
      out.push(piece);
      piece = "";
    }
    piece = piece ? `${piece} ${sentence}` : sentence;
    // A "sentence" longer than MAX (a table flattened into prose) is cut at words.
    while (piece.length > MAX) {
      const cut = piece.lastIndexOf(" ", TARGET) > MIN ? piece.lastIndexOf(" ", TARGET) : TARGET;
      out.push(piece.slice(0, cut).trim());
      piece = piece.slice(cut).trim();
    }
  }
  if (piece) out.push(piece);
  return out;
}

/** The section most of a chunk's text comes from: front matter merged into a section takes that section's name. */
function dominant(parts: Paragraph[]) {
  const sizes = new Map<string, number>();
  for (const p of parts) sizes.set(p.section, (sizes.get(p.section) || 0) + p.text.length + (p.section ? 0 : -1e6));
  return [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0].slice(0, 160);
}

/**
 * Paragraphs packed into chunks of about TARGET characters. A chunk never runs
 * from one section into the next: a section's short tail joins the chunk
 * before it, and only untitled front matter merges forward.
 */
export function chunk(paras: Paragraph[]): Chunk[] {
  const chunks: Chunk[] = [];
  let parts: Paragraph[] = [];
  let length = 0;
  const flush = () => {
    if (!parts.length) return;
    chunks.push({
      seq: chunks.length,
      text: parts.map((p) => p.text).join("\n\n"),
      pageStart: parts[0].page,
      pageEnd: parts.at(-1)!.page,
      section: dominant(parts),
    });
    parts = [];
    length = 0;
  };
  const appendToLast = () => {
    const before = chunks.at(-1);
    if (!before || before.text.length + length > MAX) return false;
    before.text += `\n\n${parts.map((p) => p.text).join("\n\n")}`;
    before.pageEnd = parts.at(-1)!.page;
    parts = [];
    length = 0;
    return true;
  };
  for (const para of paras) {
    const split = para.text.length > MAX ? pieces(para.text).map((text) => ({ ...para, text })) : [para];
    for (const part of split) {
      if (parts.length && part.section !== parts.at(-1)!.section) {
        if (length >= MIN / 2) flush();
        else if (parts.every((p) => !p.section)) {
          // Title and front matter run on into the first section.
        } else if (!appendToLast()) flush();
      }
      if (parts.length && length + part.text.length > TARGET && (length >= MIN || length + part.text.length > MAX)) flush();
      parts.push(part);
      length += part.text.length + 2;
    }
  }
  // A short last chunk joins its neighbour when they fit together.
  if (length < MIN / 2) appendToLast();
  flush();
  return chunks;
}

export function split(doc: PdfLines): Split {
  const { paragraphs: paras, referencesExcluded } = paragraphs(doc);
  const chunks = chunk(paras);
  return { chunks, chars: chunks.reduce((n, c) => n + c.text.length, 0), referencesExcluded, pages: doc.total };
}
