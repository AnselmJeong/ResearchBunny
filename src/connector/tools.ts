import { z } from "zod";
import { exportBib } from "../service/interchange/bibtex";
import { CHARACTER_TYPES, CONTRIBUTIONS } from "../shared/screening";
import type { Work } from "../shared/types";
import type { PassageHit } from "../shared/passages";
import { ConnectorError, type ConnectorLibrary } from "./library";

const characters = [...Object.keys(CHARACTER_TYPES), ...Object.keys(CONTRIBUTIONS)] as [string, ...string[]];
const scope = z
  .object({
    project: z.string().max(200).optional().describe("Project id or name (list_projects). Defaults to the project of the linked ScholarPen folder the connector runs in, or --project."),
    kind: z.enum(["archive", "collection", "topic", "character", "ids", "shelf"]).default("archive")
      .describe("archive: the project's archive · collection / topic: one of them by name (list_scopes) · character: archive papers of a type or contribution · ids: listed works · shelf: every PDF on the shelf"),
    name: z.string().max(300).optional().describe("The collection's or topic's name or id."),
    character: z.enum(characters).optional().describe("R review, M meta-analysis, O original research, or a contribution: concept, origin, debate, method, primary, rebuttal."),
    ids: z.array(z.string().max(160)).max(500).optional().describe("Work ids, for kind ids."),
  })
  .default({ kind: "archive" });

export interface ToolContext {
  lib: ConnectorLibrary;
}
export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  run: (args: z.output<S>, ctx: ToolContext) => Promise<unknown> | unknown;
}
const tool = <S extends z.ZodType>(definition: ToolDefinition<S>) => definition as unknown as ToolDefinition;

/** A paper as every tool reports it. */
function paper(lib: ConnectorLibrary, work: Work, full: { pdf: Set<string>; indexed: Set<string> }, character?: { type: string | null; contributions: string[] }) {
  return {
    id: work.id,
    citekey: work.citekey,
    title: work.title,
    authors: work.authors.slice(0, 3),
    authorCount: work.authors.length,
    year: work.year,
    venue: work.venue,
    doi: work.doi,
    pmid: work.pmid,
    type: character?.type ?? null,
    contributions: character?.contributions ?? [],
    pdf: full.pdf.has(work.id),
    indexed: full.indexed.has(work.id),
  };
}
function passages(lib: ConnectorLibrary, hits: PassageHit[]) {
  const ids = [...new Set(hits.map((h) => h.workId))];
  const works = lib.works(ids);
  const chars = lib.screening.characters(ids);
  return hits.map((h) => ({
    workId: h.workId,
    citekey: works.get(h.workId)?.citekey ?? null,
    doi: works.get(h.workId)?.doi ?? null,
    title: h.title,
    authors: h.authors.slice(0, 3),
    year: h.year,
    type: chars.get(h.workId)?.type ?? null,
    page: h.page,
    pageEnd: h.pageEnd,
    section: h.section,
    text: h.text,
    score: h.score,
    match: h.semanticRank && h.lexicalRank ? "meaning and words" : h.semanticRank ? "meaning" : "words",
  }));
}

export const TOOLS: ToolDefinition[] = [
  tool({
    name: "list_projects",
    title: "List projects",
    description: "ResearchBunny projects with their research question, archive size and linked ScholarPen folder. `current` marks the project scopes default to.",
    input: z.object({}),
    run: (_args, { lib }) => ({ projects: lib.projects() }),
  }),
  tool({
    name: "list_scopes",
    title: "List scopes",
    description: "What a project's papers can be narrowed to: collections and topics with counts, and how many archive papers have each type and contribution.",
    input: z.object({ project: z.string().max(200).optional() }),
    run: ({ project }, { lib }) => {
      const p = lib.project(project);
      const { ids } = lib.scopeIds({ project: p.id, kind: "archive" });
      const counts: Record<string, number> = {};
      for (const c of lib.screening.characters(ids).values()) {
        if (c.type) counts[c.type] = (counts[c.type] ?? 0) + 1;
        for (const k of c.contributions) counts[k] = (counts[k] ?? 0) + 1;
      }
      const profile = lib.screening.profile(p.id);
      return {
        project: { id: p.id, name: p.name, question: p.question, purpose: profile.purpose },
        archive: ids.length,
        ...lib.collectionsAndTopics(p.id),
        characters: Object.fromEntries(characters.map((c) => [c, counts[c] ?? 0])),
      };
    },
  }),
  tool({
    name: "list_works",
    title: "List works",
    description: "Papers in a scope with bibliographic data, type, contributions, whether a PDF exists and whether its passages are indexed, and the first evidence-table cells when there are any.",
    input: z.object({ scope, limit: z.number().int().min(1).max(500).default(100), offset: z.number().int().min(0).default(0) }),
    run: ({ scope: s, limit, offset }, { lib }) => {
      const { projectId, ids } = lib.scopeIds(s);
      const page = ids.slice(offset, offset + limit);
      const works = lib.works(page);
      const full = lib.fulltext(page);
      const chars = lib.screening.characters(page);
      const evidence = projectId ? lib.evidence.view(projectId, page) : null;
      const rows = new Map(evidence?.rows.map((r) => [r.workId, r]) ?? []);
      return {
        total: ids.length,
        offset,
        works: page.flatMap((id) => {
          const w = works.get(id);
          if (!w) return [];
          const row = rows.get(id);
          const cells = row
            ? Object.fromEntries(evidence!.config.columns.slice(0, 3).flatMap((c) => (row.cells[c.id]?.value ? [[c.name, row.cells[c.id].value]] : [])))
            : undefined;
          return [{ ...paper(lib, w, full, chars.get(id)), ...(cells && Object.keys(cells).length ? { evidence: cells } : {}) }];
        }),
      };
    },
  }),
  tool({
    name: "resolve_works",
    title: "Resolve works",
    description: "Finds papers in the library by DOI, PMID or title and year (in that order), and says whether each is in the project, has a PDF and has indexed passages. Use it to connect a manuscript's references to the library.",
    input: z.object({
      project: z.string().max(200).optional(),
      items: z.array(z.object({ doi: z.string().max(300).optional(), pmid: z.string().max(40).optional(), title: z.string().max(1000).optional(), year: z.number().int().optional() })).min(1).max(200),
    }),
    run: ({ project, items }, { lib }) => {
      let projectId: string | null = null;
      try {
        projectId = lib.project(project).id;
      } catch {
        projectId = null;
      }
      const found = items.map((item) => lib.resolve(item));
      const ids = found.flatMap((f) => (f ? [f.workId] : []));
      const works = lib.works(ids);
      const full = lib.fulltext(ids);
      const chars = lib.screening.characters(ids);
      return {
        results: items.map((item, i) => {
          const f = found[i];
          const w = f && works.get(f.workId);
          if (!f || !w) return { query: item, found: false };
          return { query: item, found: true, match: f.match, inProject: projectId ? lib.screeningState(projectId, f.workId) : null, ...paper(lib, w, full, chars.get(f.workId)) };
        }),
      };
    },
  }),
  tool({
    name: "find_support",
    title: "Find support for a claim",
    description: "Passages from the scope's PDFs that bear on a claim, with page and section, best first and at most two per paper. They may support or contradict it: judging that is the caller's job. Write the claim in English for the best match. Meaning search needs the local Ollama; without it only words match.",
    input: z.object({ claim: z.string().min(3).max(2000), scope, limit: z.number().int().min(1).max(40).default(8) }),
    run: async ({ claim, scope: s, limit }, { lib }) => {
      const { ids } = lib.scopeIds(s);
      if (!ids.length) return { passages: [], semantic: false, note: "The scope has no papers." };
      const result = await lib.searchPassages(claim, ids, limit, 2);
      const full = lib.fulltext(ids);
      return { passages: passages(lib, result.hits), semantic: result.semantic, coverage: { papers: ids.length, indexed: full.indexed.size } };
    },
  }),
  tool({
    name: "search_passages",
    title: "Search passages",
    description: "Passages from the scope's PDFs for a free query (keywords or a question), with page and section, best first and at most three per paper.",
    input: z.object({ query: z.string().min(2).max(2000), scope, limit: z.number().int().min(1).max(60).default(15) }),
    run: async ({ query, scope: s, limit }, { lib }) => {
      const { ids } = lib.scopeIds(s);
      if (!ids.length) return { passages: [], semantic: false, note: "The scope has no papers." };
      const result = await lib.searchPassages(query, ids, limit, 3);
      return { passages: passages(lib, result.hits), semantic: result.semantic };
    },
  }),
  tool({
    name: "get_passages",
    title: "Get a paper's passages",
    description: "One paper's passages in reading order, optionally within a page range, for reading the text around a found passage.",
    input: z.object({ workId: z.string().min(1).max(160), pageFrom: z.number().int().min(1).optional(), pageTo: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).default(40) }),
    run: ({ workId, pageFrom, pageTo, limit }, { lib }) => {
      const work = lib.works([workId]).get(workId);
      if (!work) throw new ConnectorError(`No work ${workId}.`);
      const list = lib.workPassages(workId, pageFrom, pageTo, limit);
      return { work: { id: work.id, citekey: work.citekey, title: work.title, year: work.year }, passages: list, ...(list.length ? {} : { note: "No indexed passages for this paper: it has no PDF on the shelf, or the PDF is not indexed yet." }) };
    },
  }),
  tool({
    name: "get_evidence",
    title: "Get evidence-table cells",
    description: "A paper's evidence-table row in the project: each column's value, the quote it was read from and its page. Empty cells say why (not reported, or a value that failed its check).",
    input: z.object({ workId: z.string().min(1).max(160), project: z.string().max(200).optional() }),
    run: ({ workId, project }, { lib }) => {
      const p = lib.project(project);
      const view = lib.evidence.view(p.id, [workId]);
      const row = view.rows[0];
      if (!row) return { found: false, columns: view.config.columns.map((c) => c.name) };
      return {
        found: true,
        basis: row.basis,
        stale: row.stale,
        cells: view.config.columns.map((c) => ({ column: c.name, find: c.seek, ...(row.cells[c.id] ?? { value: "", status: "not-filled" }) })),
      };
    },
  }),
  tool({
    name: "get_bibtex",
    title: "Get BibTeX",
    description: "BibTeX entries for works. Pass `keys` to choose each entry's key (the manuscript's own citekeys); otherwise the library's keys are used.",
    input: z.object({ ids: z.array(z.string().min(1).max(160)).min(1).max(500), keys: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_:.+-]{1,100}$/)).optional() }),
    run: ({ ids, keys }, { lib }) => {
      const works = lib.works(ids);
      const missing = ids.filter((id) => !works.has(id));
      const list = ids.flatMap((id) => {
        const w = works.get(id);
        if (!w) return [];
        return [{ ...w, citekey: keys?.[id] || w.citekey, bibFields: { ...w.bibFields, ...(w.pmid ? { pmid: w.pmid } : {}) } }];
      });
      return { bibtex: list.length ? exportBib(list).text : "", ...(missing.length ? { missing } : {}) };
    },
  }),
];
