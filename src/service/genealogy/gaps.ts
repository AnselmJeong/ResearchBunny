import type { GapCandidate, GenealogyCard, GenealogyPaper, PaperType } from "../../shared/genealogy";
import type { Work } from "../../shared/types";

/** Letters without accents or case, so "Ménard" and "MENARD" match. */
export const foldName = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-zÀ-ɏㄱ-힣-]/g, "");

/** The surname of an author as OpenAlex ("Robin L. Carhart-Harris") or BibTeX ("Carhart-Harris, Robin") writes it. */
export function surname(author: string) {
  const name = author.trim();
  if (name.includes(",")) return foldName(name.split(",")[0]);
  const parts = name.split(/\s+/).filter(Boolean);
  return foldName(parts[parts.length - 1] ?? "");
}

/** The cited surname and year of a mention such as "Tononi and Edelman (1998)" or "Carhart-Harris et al., 2014". */
export function parseMention(mention: string): { name: string; year: number } | null {
  const year = mention.match(/\b(1[89]\d{2}|20\d{2})[a-z]?\b/);
  if (!year) return null;
  const before = mention.slice(0, year.index).replace(/[([]/g, " ");
  const word = before.match(/([\p{Lu}][\p{L}'’-]+)/u);
  if (!word) return null;
  return { name: foldName(word[1]), year: Number(year[1]) };
}

export interface CoCitation {
  id: string;
  citers: string[];
  weight: number;
}

/**
 * References the report's papers share, by how many cite them. Reviews and
 * meta-analyses count half again: they choose what a field rests on.
 */
export function coCitations(papers: { key: string; type: PaperType | null; references: string[] }[], exclude: Set<string>): CoCitation[] {
  const counts = new Map<string, CoCitation>();
  for (const p of papers)
    for (const ref of new Set(p.references)) {
      if (exclude.has(ref)) continue;
      const entry = counts.get(ref) ?? { id: ref, citers: [], weight: 0 };
      entry.citers.push(p.key);
      entry.weight += p.type === "R" || p.type === "M" ? 1.5 : 1;
      counts.set(ref, entry);
    }
  return [...counts.values()].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/** How many of the report's papers a reference must be shared by to be a candidate. */
export const coCitationThreshold = (size: number) => Math.max(2, Math.ceil(size * 0.1));

/**
 * A card's mention resolved inside the citing paper's own reference list,
 * where an author and year are nearly unique.
 */
export function resolveMention(mention: string, references: Work[]): Work | null {
  const parsed = parseMention(mention);
  if (!parsed) return null;
  const matches = references.filter((w) => w.year !== null && Math.abs(w.year - parsed.year) <= 1 && w.authors.length > 0 && surname(w.authors[0]) === parsed.name);
  const exact = matches.filter((w) => w.year === parsed.year);
  if (exact.length === 1) return exact[0];
  return matches.length === 1 ? matches[0] : null;
}

/** Corpus papers a citing work cites, from its reference list. */
export const citedCorpus = (work: Work, corpus: Map<string, string>) =>
  [...new Set((work.references ?? []).map((id) => corpus.get(id)).filter((k): k is string => !!k))];

export const forwardThreshold = (size: number) => Math.max(2, Math.ceil(size * 0.15));

/** The ranking before and after the model's judgement; requests from writing weigh in on top. */
export function score(c: Pick<GapCandidate, "cocited" | "mentions" | "cites" | "requests" | "relevance">, size: number) {
  const scale = Math.max(3, size * 0.25);
  const a = Math.min(1, c.cocited.length / scale);
  const b = Math.min(1, new Set(c.mentions.map((m) => m.key)).size / 2);
  const f = Math.min(1, c.cites.length / scale);
  const relevance = c.relevance ?? 0.5;
  return Math.round((0.35 * a + 0.25 * b + 0.15 * f + 0.25 * relevance + (c.requests.length ? 0.2 : 0)) * 1000) / 1000;
}

/** Mentions of earlier work in the cards, by citing paper. */
export function mentionsByPaper(papers: GenealogyPaper[], cards: Map<string, GenealogyCard>) {
  const result: { paper: GenealogyPaper; mentions: GenealogyCard["foundations"] }[] = [];
  for (const paper of papers) {
    const card = cards.get(paper.workId);
    const mentions = (card?.foundations ?? []).filter((f) => parseMention(f.mention));
    if (mentions.length) result.push({ paper, mentions });
  }
  return result;
}
