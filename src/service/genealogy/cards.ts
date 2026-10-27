import { z } from "zod";
import { PAPER_TYPES, TEXT_BASIS, type GenealogyCard, type GenealogyPaper, type GenealogySettings, type PaperType } from "../../shared/genealogy";
import type { Work } from "../../shared/types";

const ROLES = ["origin", "support", "refute", "method", "review"] as const;
export const ROLE_NAMES: Record<(typeof ROLES)[number], string> = {
  origin: "출발점",
  support: "지지",
  refute: "반박",
  method: "방법",
  review: "정리",
};

export const CARD_SCHEMA = {
  type: "object",
  properties: {
    position: { type: "string" },
    problem: { type: "string" },
    claims: { type: "array", items: { type: "string" } },
    evidence: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" }, quote: { type: "string" } }, required: ["text", "quote"], additionalProperties: false },
    },
    critique: { type: "string" },
    unresolved: { type: "array", items: { type: "string" } },
    interests: { type: "string" },
    significance: { type: "string" },
    foundations: {
      type: "array",
      items: {
        type: "object",
        properties: { mention: { type: "string" }, role: { type: "string", enum: [...ROLES] }, claim: { type: "string" } },
        required: ["mention", "role", "claim"],
        additionalProperties: false,
      },
    },
    statusSignals: { type: "array", items: { type: "string" } },
    cautions: { type: "array", items: { type: "string" } },
  },
  required: ["position", "problem", "claims", "evidence", "critique", "unresolved", "interests", "significance", "foundations", "statusSignals", "cautions"],
  additionalProperties: false,
};

const cardShape = z.object({
  position: z.string(),
  problem: z.string().min(1),
  claims: z.array(z.string()).max(12),
  evidence: z.array(z.object({ text: z.string().min(1), quote: z.string() })).max(16),
  critique: z.string(),
  unresolved: z.array(z.string()).max(10),
  interests: z.string(),
  significance: z.string().min(1),
  foundations: z.array(z.object({ mention: z.string().min(2), role: z.enum(ROLES), claim: z.string() })).max(30),
  statusSignals: z.array(z.string()).max(10),
  cautions: z.array(z.string()).max(12),
});

const READING: Record<PaperType, string> = {
  R: "This is a review, conceptual, historical or commentary paper: you were given its whole body. Extract its argument and how it organises the field.",
  M: "This is a systematic review or meta-analysis: you were given its introduction and discussion. Extract what it pooled, its headline estimates and how it judged the evidence; skip result tables.",
  O: "This is original research: you were given its introduction and the opening of its discussion. The introduction is a snapshot of what the field took as settled and as open at the time. Extract that snapshot, what the study asked, what it found in one or two sentences, and what the finding ruled out.",
  P: "This paper is peripheral to the research question: you were given its abstract and the start of its introduction. Extract only what bears on the research question and why it sits at the edge of the topic.",
};

export function cardInstruction(type: PaperType, settings: GenealogySettings) {
  return `You read one paper for a genealogy review: how a research question arose, which hypotheses were proposed, which evidence supported or refuted them, which lines of work branched off, which ones hit a wall and which survived. The reader of the final review is: ${settings.reader}. ${READING[type]}

Write every field in Korean, except "quote" and "mention", which stay exactly as in the paper. Use only the supplied text and metadata; never add facts, numbers or citations from memory.
- position: whom this paper answers and who would take it up, as far as the text shows.
- problem: what the authors saw as the problem.
- claims: hypotheses, definitions and main claims.
- evidence: key findings with numbers copied verbatim (effect sizes, %, n). "quote" must be one exact sentence or clause copied character for character from the supplied text that supports the item.
- critique: the interpretation that matters and any methodological criticism (enrichment, discontinuation designs, short follow-up, small or selected samples, sponsorship).
- unresolved: what the paper leaves open.
- interests: funding, conflicts of interest and school of thought, or "확인되지 않음".
- significance: one or two sentences on the role this paper plays in the genealogy.
- foundations: earlier works the text relies on, as cited (e.g. "Tononi and Edelman (1998)" or "[12] Smith et al."), with their role: origin (where the idea started), support, refute, method, review.
- statusSignals: sentences that say a line of work was abandoned, refuted, superseded, revived or is now dominant.
- cautions: extraction problems, uncertain bibliographic data, overinterpretation risks.`;
}

export function cardInput(paper: GenealogyPaper, work: Work, settings: GenealogySettings, text: string) {
  return JSON.stringify({
    researchQuestion: settings.question,
    paper: { key: paper.key, title: work.title, authors: work.authors.slice(0, 12), year: work.year, venue: work.venue, doi: work.doi, type: `${paper.type} (${PAPER_TYPES[paper.type as PaperType]})` },
    readingScope: paper.textNote,
    text,
  });
}

/** Whitespace, soft hyphens and line-break hyphenation differ between extraction and a copied quote. */
export function normalizeQuote(text: string) {
  return text
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1$2")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const numbers = (text: string) => text.match(/\d+(?:[.,]\d+)?/g) ?? [];

/**
 * Parses a card and checks it against the text it was read from. Evidence whose
 * quote is not in the text is dropped; when most of it fails the reply is
 * rejected so the model tries again.
 */
export function parseCard(value: unknown, source: string, key: string, type: PaperType, strict: boolean): GenealogyCard {
  const raw = cardShape.parse(value);
  const haystack = normalizeQuote(source);
  const kept = raw.evidence.filter((e) => e.quote.trim().length >= 12 && haystack.includes(normalizeQuote(e.quote)));
  const dropped = raw.evidence.length - kept.length;
  if (strict && raw.evidence.length >= 2 && dropped * 2 > raw.evidence.length)
    throw new Error(`${dropped} of ${raw.evidence.length} evidence quotes are not exact substrings of the supplied text; copy each quote character for character`);
  const cautions = [...raw.cautions];
  if (dropped) cautions.push(`근거 ${dropped}개는 인용문이 원문과 일치하지 않아 뺐습니다.`);
  const sourceNumbers = new Set(numbers(source));
  const unsupported = [...new Set(kept.flatMap((e) => numbers(e.text)).filter((n) => !sourceNumbers.has(n)))];
  if (unsupported.length) cautions.push(`원문에서 찾지 못한 수치: ${unsupported.slice(0, 8).join(", ")} — 확인 필요`);
  return { ...raw, evidence: kept, cautions, key, type };
}

export const MERGE_INSTRUCTION = `You are given partial cards that were each read from one part of the same long paper, in order. Merge them into one card for the whole paper with the same fields. Keep every evidence item and quote exactly as given (drop only duplicates), keep foundations and status signals from all parts, and write a single position, problem, critique and significance for the whole paper. Write in Korean except quotes and mentions.`;

/** Splits a long reading text at paragraph breaks into parts of at most `size` characters. */
export function splitText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > size) {
      parts.push(current);
      current = "";
    }
    if (paragraph.length > size) {
      for (let i = 0; i < paragraph.length; i += size) parts.push(paragraph.slice(i, i + size));
      continue;
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) parts.push(current);
  return parts;
}

const list = (items: string[]) => (items.length ? items.map((i) => `\n  - ${i}`).join("") : " —");

/** The card as the genealogy skill's Markdown template. */
export function cardMarkdown(card: GenealogyCard, paper: GenealogyPaper, work: Work) {
  const authors = work.authors.length > 3 ? `${work.authors.slice(0, 3).join(", ")} 외` : work.authors.join(", ");
  return `# ${card.key} — ${authors} ${work.year ?? "연도 미상"}, ${work.venue || "출처 미상"} (${card.type})

- 제목: ${work.title}
- 유형: ${card.type} (${PAPER_TYPES[card.type]}) | 읽은 범위: ${TEXT_BASIS[paper.basis]} · ${paper.textNote}
- 계보 위치: ${card.position || "—"}
- 문제제기: ${card.problem}
- 가설·주장·정의:${list(card.claims)}
- 근거:${list(card.evidence.map((e) => `${e.text} — “${e.quote}”`))}
- 해석의 핵심·방법론 비판: ${card.critique || "—"}
- 미해결:${list(card.unresolved)}
- 자금·이해상충·학파: ${card.interests || "—"}
- 계보상 의의: ${card.significance}
- 앞선 연구:${list(card.foundations.map((f) => `${f.mention} (${ROLE_NAMES[f.role]}) — ${f.claim}`))}
- 가지 상태 신호:${list(card.statusSignals)}
- DOI: ${work.doi ?? "—"}
- ⚠ 주의:${list(card.cautions)}
`;
}
