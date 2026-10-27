import { z } from "zod";
import type { Branch, GenealogyCard, GenealogyPaper, GenealogySettings, MissingSource, Outline, OutlineChapter, OutlineSection } from "../../shared/genealogy";
import { NUMERIC_CITATION, citedKeys, dropCitations } from "../../shared/citations";
import type { Work } from "../../shared/types";

export const SECTION_SCHEMA = {
  type: "object",
  properties: {
    markdown: { type: "string" },
    summary: { type: "string" },
    missingSources: {
      type: "array",
      items: {
        type: "object",
        properties: { need: { type: "string" }, hint: { type: "string" }, kind: { type: "string", enum: ["primary", "recent", "counter"] } },
        required: ["need", "hint", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["markdown", "summary", "missingSources"],
  additionalProperties: false,
};

/** The writing rules of the genealogy skill and of this report's reader. */
export function sectionInstruction(settings: GenealogySettings) {
  return `You write one section of a genealogy review in Korean academic prose. Reader: ${settings.reader}. The review explains how the research question arose, how it developed, which branches split off, which hit a wall and which survived, so that a newcomer understands the field. Length is not limited; write what the reader needs to follow the argument.

Rules:
- Open with the section's thesis as an argument, not a topic label. Cite papers as evidence for claims grouped under that argument; never list studies one by one.
- Follow "claim → objection → the evidence that decides between them" where the material allows.
- For each experiment you mention, say three things only: which question in the story it tried to answer, its design and result in one or two sentences, and what that result ruled out or changed. Do not describe methods in detail.
- Make each branch's status explicit: if it hit a wall, why; if it survived, what kept it alive; note when an old dispute returns in a new methodological language.
- Define technical terms at first use for this reader.
- Take numbers only from the supplied cards, verbatim. Name who made a claim (school, insider, sponsor) when it matters.
- Cite only with Pandoc syntax and only keys from allowedKeys: [@key], [@a; @b], [@key, p. 12], or "@key 는 …" when the paper is the subject. Never use numeric citations, author–year in plain text, footnotes, URLs, DOIs or a reference list.
- If an important claim needs a source that is not in allowedKeys (an original paper behind a review's statement, a recent result, a counter-argument), do not cite or invent it; write around it and list it in missingSources with what is needed and any hint (author, year, title as the cards mention it).
- Do not repeat the section title; you may use ### subheadings. Continue from the previous sections without repeating them.
- summary: three sentences on what this section established, for the sections that follow.`;
}

export function sectionInput(input: {
  settings: GenealogySettings;
  outline: Outline;
  chapter: OutlineChapter;
  section: OutlineSection;
  branches: Branch[];
  cards: { paper: GenealogyPaper; work: Work; card: GenealogyCard | undefined }[];
  others: { key: string; year: number | null; title: string; significance: string }[];
  previous: { id: string; title: string; summary: string }[];
  allowed: { key: string; label: string }[];
}) {
  const { outline, chapter, section } = input;
  return JSON.stringify({
    researchQuestion: input.settings.question,
    review: { title: outline.title, thesis: outline.summary, contents: outline.chapters.map((c) => ({ chapter: `${c.number}. ${c.title}`, thesis: c.thesis, sections: c.sections.map((s) => `${s.id} ${s.title}`) })) },
    chapter: { number: chapter.number, title: chapter.title, thesis: chapter.thesis },
    section: { id: section.id, title: section.title, thesis: section.thesis, questions: section.questions, decidingEvidence: section.evidence },
    branches: input.branches.filter((b) => section.branches.includes(b.id)).map((b) => ({ id: b.id, name: b.name, status: b.status, claim: b.claim, evidence: b.evidence, reason: b.reason })),
    cards: input.cards.map(({ paper, work, card }) => ({
      key: paper.key,
      citation: `${work.authors.slice(0, 3).join(", ")}${work.authors.length > 3 ? " et al." : ""} (${work.year ?? "n.d."}) ${work.title}, ${work.venue}`,
      type: paper.type,
      readFrom: paper.textNote,
      card: card ?? null,
    })),
    otherPapersInChapter: input.others,
    previousSections: input.previous,
    allowedKeys: input.allowed,
  });
}

const sectionShape = z.object({
  markdown: z.string().min(200),
  summary: z.string(),
  missingSources: z.array(z.object({ need: z.string(), hint: z.string(), kind: z.enum(["primary", "recent", "counter"]) })).max(12),
});

/** Numbers a section may state: those in the cards, years, and small counts. */
export function numberPool(cards: Iterable<GenealogyCard>) {
  const pool = new Set<string>();
  for (const card of cards)
    for (const text of [card.problem, card.critique, card.significance, card.position, ...card.claims, ...card.evidence.flatMap((e) => [e.text, e.quote]), ...card.unresolved])
      for (const n of text.match(/\d+(?:[.,]\d+)?/g) ?? []) pool.add(n.replace(",", "."));
  return pool;
}

const unsupportedNumbers = (markdown: string, pool: Set<string>) => {
  const prose = markdown.replace(/\[[^\]]*@[^\]]*\]/g, "").replace(/^#+.*$/gm, "");
  return [
    ...new Set(
      [...(prose.match(/\d+(?:[.,]\d+)?(?=\s*(?:%|명|편|배|mg|ms|Hz|개|건|주|개월|년간|점))/g) ?? []), ...(prose.match(/\d+[.,]\d+/g) ?? [])]
        .map((n) => n.replace(",", "."))
        .filter((n) => !pool.has(n) && !/^(1[89]|20)\d{2}$/.test(n)),
    ),
  ];
};

export interface WrittenSection {
  markdown: string;
  summary: string;
  usedKeys: string[];
  missing: MissingSource[];
  problems: string[];
}

/**
 * Checks a written section. The first answer must cite only allowed keys and no
 * numbers in brackets; the second has offending citations removed and reported.
 */
export function parseSection(value: unknown, title: string, allowed: Set<string>, strict: boolean, pool: Set<string>): WrittenSection {
  const parsed = sectionShape.parse(value);
  let markdown = parsed.markdown.trim().replace(/^#{1,3}\s+.*\n+/, (line) => (line.includes(title.slice(0, 12)) ? "" : line));
  const problems: string[] = [];
  const unknown = citedKeys(markdown).filter((k) => !allowed.has(k));
  if (unknown.length) {
    if (strict) throw new Error(`cited keys not in allowedKeys: ${unknown.join(", ")}; cite only allowedKeys and list other sources in missingSources`);
    markdown = dropCitations(markdown, new Set(unknown));
    problems.push(`허용되지 않은 인용 키를 뺐습니다: ${unknown.join(", ")}`);
  }
  const numeric = markdown.match(NUMERIC_CITATION) ?? [];
  if (numeric.length) {
    if (strict) throw new Error(`numeric citations are not allowed: ${numeric.slice(0, 5).join(" ")}; use [@key]`);
    problems.push(`번호 인용 형식이 남아 있습니다: ${numeric.slice(0, 5).join(" ")}`);
  }
  const numbers = unsupportedNumbers(markdown, pool);
  if (numbers.length) problems.push(`카드에서 찾지 못한 수치: ${numbers.slice(0, 10).join(", ")} — 확인 필요`);
  return { markdown, summary: parsed.summary, usedKeys: citedKeys(markdown), missing: parsed.missingSources, problems };
}

/** One chapter file: its heading, its thesis as the opening summary, and its sections. */
export function chapterMarkdown(chapter: OutlineChapter, texts: Map<string, string>) {
  const parts = [`# ${chapter.number}. ${chapter.title}`, ""];
  if (chapter.thesis) parts.push(`**요지.** ${chapter.thesis}`, "");
  for (const s of chapter.sections) {
    parts.push(`## ${s.id} ${s.title}`, "");
    parts.push(texts.get(s.uid)?.trim() || "*(아직 쓰지 않은 절)*", "");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}
