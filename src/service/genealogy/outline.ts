import { z } from "zod";
import {
  BRANCH_STATUS,
  type Branch,
  type BranchStatus,
  type GenealogyCard,
  type GenealogyPaper,
  type GenealogySettings,
  type Outline,
  type OutlineChapter,
  type OutlineSection,
} from "../../shared/genealogy";
import type { Work } from "../../shared/types";

// --- Evidence pack: what the citation record says, before any model reads it ---

export interface EvidencePack {
  timeline: { key: string; year: number | null; type: string; title: string }[];
  /** citing key → cited key, among the report's papers. */
  citations: [string, string][];
  /** Groups of papers that cite each other or share references. */
  clusters: { id: string; keys: string[]; years: [number | null, number | null] }[];
  /** Recent works citing each paper, from the gap check. */
  recentCiters: Record<string, number>;
}

/** Deterministic label propagation over direct citations and shared references. */
export function clusters(papers: { key: string; refs: Set<string>; openalex: string | null }[]): string[][] {
  const index = new Map(papers.map((p, i) => [p.key, i]));
  const byOa = new Map(papers.filter((p) => p.openalex).map((p) => [p.openalex!, p.key]));
  const weights = papers.map(() => new Map<number, number>());
  const link = (a: number, b: number, w: number) => {
    if (a === b) return;
    weights[a].set(b, (weights[a].get(b) ?? 0) + w);
    weights[b].set(a, (weights[b].get(a) ?? 0) + w);
  };
  for (const [i, p] of papers.entries()) {
    for (const ref of p.refs) {
      const cited = byOa.get(ref);
      if (cited !== undefined) link(i, index.get(cited)!, 2);
    }
    for (let j = i + 1; j < papers.length; j++) {
      let shared = 0;
      for (const ref of p.refs) if (papers[j].refs.has(ref)) shared++;
      if (shared >= 2) link(i, j, Math.min(3, shared / 3));
    }
  }
  const labels = papers.map((_, i) => i);
  for (let round = 0; round < 20; round++) {
    let changed = false;
    for (let i = 0; i < papers.length; i++) {
      const votes = new Map<number, number>();
      for (const [j, w] of weights[i]) votes.set(labels[j], (votes.get(labels[j]) ?? 0) + w);
      if (!votes.size) continue;
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      if (best !== labels[i] && (votes.get(best) ?? 0) > (votes.get(labels[i]) ?? 0)) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const groups = new Map<number, string[]>();
  labels.forEach((label, i) => groups.set(label, [...(groups.get(label) ?? []), papers[i].key]));
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

export function evidencePack(papers: GenealogyPaper[], works: Map<string, Work>, recentCiters: Record<string, number>): EvidencePack {
  const corpus = new Map(papers.map((p) => [works.get(p.workId)?.openalex ?? "", p.key] as [string, string]).filter(([oa]) => !!oa));
  const citations: [string, string][] = [];
  for (const p of papers)
    for (const ref of works.get(p.workId)?.references ?? []) {
      const cited = corpus.get(ref);
      if (cited && cited !== p.key) citations.push([p.key, cited]);
    }
  const year = new Map(papers.map((p) => [p.key, p.year]));
  const groups = clusters(papers.map((p) => ({ key: p.key, refs: new Set(works.get(p.workId)?.references ?? []), openalex: works.get(p.workId)?.openalex ?? null })));
  return {
    timeline: papers.map((p) => ({ key: p.key, year: p.year, type: p.type ?? "?", title: p.title })),
    citations,
    clusters: groups.map((keys, i) => {
      const years = keys.map((k) => year.get(k)).filter((y): y is number => typeof y === "number");
      return { id: `c${i + 1}`, keys, years: [years.length ? Math.min(...years) : null, years.length ? Math.max(...years) : null] as [number | null, number | null] };
    }),
    recentCiters,
  };
}

/** What the outline and the ledger read about each paper: the card's gist, not its quotes. */
export function digest(paper: GenealogyPaper, card: GenealogyCard | undefined, work: Work) {
  return {
    key: paper.key,
    year: paper.year,
    type: paper.type,
    title: paper.title,
    authors: work.authors.slice(0, 3),
    basis: paper.basis,
    significance: card?.significance ?? "",
    position: card?.position ?? "",
    claims: card?.claims.slice(0, 4) ?? [],
    critique: card?.critique ?? "",
    statusSignals: card?.statusSignals ?? [],
    foundations: card?.foundations.slice(0, 6).map((f) => `${f.mention} (${f.role})`) ?? [],
  };
}

// --- Branch ledger ---

const STATUSES = Object.keys(BRANCH_STATUS) as BranchStatus[];
export const LEDGER_SCHEMA = {
  type: "object",
  properties: {
    branches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          origin: { type: "array", items: { type: "string" } },
          claim: { type: "string" },
          turningPoints: { type: "array", items: { type: "object", properties: { key: { type: "string" }, note: { type: "string" } }, required: ["key", "note"], additionalProperties: false } },
          status: { type: "string", enum: STATUSES },
          evidence: { type: "string" },
          reason: { type: "string" },
          lastActive: { type: ["integer", "null"] },
        },
        required: ["name", "origin", "claim", "turningPoints", "status", "evidence", "reason", "lastActive"],
        additionalProperties: false,
      },
    },
  },
  required: ["branches"],
  additionalProperties: false,
};

export function ledgerInstruction(settings: GenealogySettings) {
  return `You are building the branch ledger of a genealogy review for this reader: ${settings.reader}. From the paper digests and the citation record, identify the lines of work (branches) that grew from the research question: where each started, what it claimed, which papers turned it, and its status now.
Status: alive (still productive and supported), blocked (hit a wall: refuted, a methodological dead end, superseded, or the tools to test it do not exist), merged (absorbed into another branch), dormant (abandoned without refutation), contested (actively disputed).
Judge status from the digests' status signals, critiques and refutations, and from the citation record: years of activity and recent citing works per paper. Say in "evidence" which of these you relied on; for a blocked branch say in "reason" what the wall was. Use only keys from the digests in origin and turningPoints. Write names and prose in Korean. Usually 3 to 9 branches.`;
}

const branchShape = z.object({
  branches: z
    .array(
      z.object({
        name: z.string().min(1),
        origin: z.array(z.string()),
        claim: z.string(),
        turningPoints: z.array(z.object({ key: z.string(), note: z.string() })),
        status: z.enum(STATUSES as [BranchStatus, ...BranchStatus[]]),
        evidence: z.string(),
        reason: z.string(),
        lastActive: z.number().int().nullable(),
      }),
    )
    .min(1)
    .max(15),
});

export function parseLedger(value: unknown, keys: Set<string>): Branch[] {
  const parsed = branchShape.parse(value);
  const used = parsed.branches.flatMap((b) => [...b.origin, ...b.turningPoints.map((t) => t.key)]);
  const unknown = used.filter((k) => !keys.has(k));
  if (unknown.length > Math.max(2, used.length / 5)) throw new Error(`unknown keys: ${[...new Set(unknown)].slice(0, 10).join(", ")}; use only keys from the digests`);
  return parsed.branches.map((b, i) => ({
    ...b,
    id: `b${i + 1}`,
    origin: b.origin.filter((k) => keys.has(k)),
    turningPoints: b.turningPoints.filter((t) => keys.has(t.key)),
  }));
}

// --- Outline ---

export const OUTLINE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    summary: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          thesis: { type: "string" },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                thesis: { type: "string" },
                questions: { type: "array", items: { type: "string" } },
                evidence: { type: "string" },
                keys: { type: "array", items: { type: "string" } },
                branches: { type: "array", items: { type: "string" } },
              },
              required: ["title", "thesis", "questions", "evidence", "keys", "branches"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "thesis", "sections"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "subtitle", "summary", "chapters"],
  additionalProperties: false,
};

export function outlineInstruction(settings: GenealogySettings) {
  return `Write the detailed table of contents of a genealogy review in Korean for this reader: ${settings.reader}. The review tells how the research question arose, how it developed, which branches split off, which hit a wall and which survived, so that a newcomer understands the field. Use the branch ledger as the backbone.
- Chapters: an opening chapter on how the question arose, then chapters that follow the branches (one branch or a group of related branches per chapter, in roughly historical order), then a closing synthesis chapter (current consensus, open problems, new hypotheses). Usually 5 to 10 chapters with 2 to 6 sections each.
- Each chapter and section starts with a thesis sentence: the argument it makes, not a topic label. Sections follow "claim → objection → the evidence that decides between them" where the material allows.
- questions: what the section answers. evidence: which studies decide it and what they rule out, in one line.
- keys: the papers the section rests on, using only keys from the digests; every paper should appear in at least one section. branches: ids from the ledger.
- title is the review's title; subtitle names its scope; summary is the review's thesis in three or four sentences.`;
}

const outlineShape = z.object({
  title: z.string().min(1),
  subtitle: z.string(),
  summary: z.string(),
  chapters: z
    .array(
      z.object({
        title: z.string().min(1),
        thesis: z.string(),
        sections: z.array(z.object({ title: z.string().min(1), thesis: z.string(), questions: z.array(z.string()), evidence: z.string(), keys: z.array(z.string()), branches: z.array(z.string()) })).min(1),
      }),
    )
    .min(2)
    .max(16),
});

export const chapterFile = (number: number, title: string) =>
  `${String(number).padStart(2, "0")}_${title.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "장"}.md`;

function section(chapter: number, index: number, s: { title: string; thesis: string; questions: string[]; evidence: string; keys: string[]; branches: string[] }, prior?: OutlineSection): OutlineSection {
  const id = `${chapter}.${index}`;
  const same = prior && prior.title === s.title && prior.keys.join() === s.keys.join() && prior.thesis === s.thesis;
  return {
    id,
    chapter,
    title: s.title,
    thesis: s.thesis,
    questions: s.questions,
    evidence: s.evidence,
    keys: s.keys,
    branches: s.branches,
    status: same ? prior.status : "planned",
    summary: same ? prior.summary : "",
    usedKeys: same ? prior.usedKeys : [],
    missing: same ? prior.missing : [],
    problems: same ? prior.problems : [],
    rewrites: same ? prior.rewrites : 0,
    writtenAt: same ? prior.writtenAt : null,
  };
}

/** The model's outline with numbering, chapter files and every key checked; unassigned papers are reported. */
export function parseOutline(value: unknown, keys: Set<string>, strict: boolean): { outline: Outline; unassigned: string[] } {
  const parsed = outlineShape.parse(value);
  const used = parsed.chapters.flatMap((c) => c.sections.flatMap((s) => s.keys));
  const unknown = used.filter((k) => !keys.has(k));
  if (unknown.length > Math.max(2, used.length / 5)) throw new Error(`unknown keys: ${[...new Set(unknown)].slice(0, 10).join(", ")}; use only keys from the digests`);
  const assigned = new Set(used);
  const unassigned = [...keys].filter((k) => !assigned.has(k));
  if (strict && unassigned.length > Math.max(1, keys.size * 0.1)) throw new Error(`these papers are in no section: ${unassigned.slice(0, 30).join(", ")}; place every paper in at least one section`);
  return {
    outline: {
      title: parsed.title,
      subtitle: parsed.subtitle,
      summary: parsed.summary,
      chapters: parsed.chapters.map((c, i) => ({
        number: i + 1,
        title: c.title,
        thesis: c.thesis,
        file: chapterFile(i + 1, c.title),
        sections: c.sections.map((s, j) => section(i + 1, j + 1, { ...s, keys: s.keys.filter((k) => keys.has(k)) })),
      })),
    },
    unassigned,
  };
}

// --- 00_contents.md: written for people, read back after they edit it ---

export function outlineMarkdown(outline: Outline) {
  const lines = [`# ${outline.title}`, ""];
  if (outline.subtitle) lines.push(`*${outline.subtitle}*`, "");
  if (outline.summary) lines.push(`**요지.** ${outline.summary}`, "");
  lines.push("<!-- 장·절 제목, 논지, 질문, 증거를 고쳐도 됩니다. rb:section 주석은 그 절이 기대는 문헌(keys)과 가지(branches)입니다. -->", "");
  for (const c of outline.chapters) {
    lines.push(`## ${c.number}. ${c.title}`, "");
    if (c.thesis) lines.push(c.thesis, "");
    for (const s of c.sections) {
      lines.push(`### ${s.id} ${s.title}`, `<!-- rb:section keys=${s.keys.join(",")} branches=${s.branches.join(",")} -->`);
      if (s.thesis) lines.push(`- 논지: ${s.thesis}`);
      if (s.questions.length) lines.push(`- 다룰 질문: ${s.questions.join(" / ")}`);
      if (s.evidence) lines.push(`- 가를 증거: ${s.evidence}`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Reads an edited 00_contents.md back; renumbers chapters and sections and keeps what each section already had when it did not change. */
export function parseOutlineMarkdown(markdown: string, prior: Outline | null): Outline {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const outline: Outline = { title: prior?.title ?? "", subtitle: "", summary: "", chapters: [] };
  const priorSections = new Map((prior?.chapters ?? []).flatMap((c) => c.sections.map((s) => [s.title, s] as const)));
  let chapter: OutlineChapter | null = null;
  let current: { title: string; thesis: string; questions: string[]; evidence: string; keys: string[]; branches: string[] } | null = null;
  const flush = () => {
    if (chapter && current) chapter.sections.push(section(chapter.number, chapter.sections.length + 1, current, priorSections.get(current.title)));
    current = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^#\s+(.+)$/))) outline.title = m[1].trim();
    else if ((m = line.match(/^##\s+(?:\d+[.)]?\s*)?(.+)$/))) {
      flush();
      const number = outline.chapters.length + 1;
      chapter = { number, title: m[1].trim(), thesis: "", file: chapterFile(number, m[1].trim()), sections: [] };
      outline.chapters.push(chapter);
    } else if ((m = line.match(/^###\s+(?:\d+(?:\.\d+)*[.)]?\s*)?(.+)$/))) {
      flush();
      current = { title: m[1].trim(), thesis: "", questions: [], evidence: "", keys: [], branches: [] };
    } else if ((m = line.match(/^<!--\s*rb:section\s+(.*?)-->$/))) {
      if (current) {
        current.keys = (m[1].match(/keys=([^\s]*)/)?.[1] ?? "").split(",").filter(Boolean);
        current.branches = (m[1].match(/branches=([^\s]*)/)?.[1] ?? "").split(",").filter(Boolean);
      }
    } else if (line.startsWith("<!--")) continue;
    else if ((m = line.match(/^-\s*논지:\s*(.*)$/)) && current) current.thesis = m[1];
    else if ((m = line.match(/^-\s*다룰 질문:\s*(.*)$/)) && current) current.questions = m[1].split(/\s+\/\s+/).filter(Boolean);
    else if ((m = line.match(/^-\s*가를 증거:\s*(.*)$/)) && current) current.evidence = m[1];
    else if ((m = line.match(/^\*\*요지\.\*\*\s*(.*)$/)) && !chapter) outline.summary = m[1];
    else if ((m = line.match(/^\*(.+)\*$/)) && !chapter) outline.subtitle = m[1];
    else if (line && chapter && !current && !chapter.sections.length) chapter.thesis = chapter.thesis ? `${chapter.thesis} ${line}` : line;
  }
  flush();
  if (!outline.chapters.length) throw new Error("목차에서 장(## 제목)을 찾지 못했습니다.");
  return outline;
}

export function ledgerMarkdown(branches: Branch[], keyTitles: Map<string, string>) {
  const lines = ["# 부록 A. 가지 장부", "", "| 가지 | 상태 | 출발 | 마지막 활동 |", "|---|---|---|---|"];
  for (const b of branches) lines.push(`| ${b.name} | ${BRANCH_STATUS[b.status]} | ${b.origin.map((k) => `[@${k}]`).join("; ") || "—"} | ${b.lastActive ?? "—"} |`);
  lines.push("");
  for (const b of branches) {
    lines.push(`## ${b.name} · ${BRANCH_STATUS[b.status]}`, "", b.claim, "");
    if (b.turningPoints.length) {
      lines.push("전환점:", "");
      for (const t of b.turningPoints) lines.push(`- ${keyTitles.get(t.key) ? `${t.note} [@${t.key}]` : t.note}`);
      lines.push("");
    }
    lines.push(`상태의 근거: ${b.evidence}`, "");
    if (b.reason) lines.push(`${b.status === "blocked" ? "막힌 이유" : "덧붙임"}: ${b.reason}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
