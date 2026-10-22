import type { Library } from "../db/database";
import type { OpenAlex } from "../providers/openalex";
import type { LinkedDiscoveries } from "../providers/linked-discoveries";
import {
  AppError,
  type LinkGroup,
  type LinkedWork,
  type Work,
  type WorkLinks,
} from "../../shared/types";
import { pmidOf } from "../../shared/domain";
import type { Input } from "../../shared/contracts";

/** Shelf papers like this one, from local embeddings. No API call. */
export interface SimilarSource {
  enabled(): boolean;
  similar(workId: string, limit: number, otherFolders: boolean, signal: AbortSignal): Promise<{ hits: { workId: string; score: number }[]; notice: string }>;
}
const CITING_PAGE = "50";
const PUBMED_SIZE = 20;
const SHELF_SIZE = 10;
const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const message = (error: unknown) => (error instanceof Error ? error.message : "조회하지 못했습니다.");
/** Budget, rate and network failures stop the whole list; the user retries it. */
const fatal = (error: unknown) =>
  error instanceof AppError && ["RATE_LIMIT", "DAILY_BUDGET", "API_KEY", "CANCELLED", "TIMEOUT"].includes(error.code);

/**
 * The inspector's lists for one paper. Fetched papers are stored as works so they
 * can be inspected and saved, but none joins the project, and so none reaches the
 * review queue, until the user saves it or adds it to a collection.
 */
export class Links {
  constructor(
    private db: Library,
    private oa: OpenAlex,
    private ld: LinkedDiscoveries,
    private shelf?: SimilarSource,
  ) {}
  private call = () => this.db.usage("openalex", "links");
  async load(input: Input<"workLinks">, signal: AbortSignal = AbortSignal.timeout(90000)): Promise<WorkLinks> {
    const notices: string[] = [];
    const work = await this.hydrate(this.db.get(input.workId), signal, notices);
    const sort = input.sort || "citations";
    if (input.mode === "references") return { groups: await this.references(input.projectId, work, sort, signal, notices), notices };
    if (input.mode === "citedBy") return { groups: await this.citing(input.projectId, work, sort, input.cursor, signal, notices), notices };
    return { groups: await this.related(input.projectId, work, !!input.otherFolders, signal, notices), notices };
  }
  /** A paper imported from BibTeX or a PDF may have a DOI or PMID but no OpenAlex record yet. */
  private async hydrate(work: Work, signal: AbortSignal, notices: string[]): Promise<Work> {
    if ((work.openalex && work.references !== null) || !(work.doi || pmidOf(work))) return work;
    try {
      const page = await this.oa.lookup(work.doi || `pmid:${pmidOf(work)}`, signal, this.call);
      const merged = this.db.upsert(page.works[0]).work;
      return merged.id === work.id ? merged : work;
    } catch (error) {
      if (fatal(error)) throw error;
      notices.push(`OpenAlex에서 이 논문을 확인하지 못했습니다 · ${message(error)}`);
      return work;
    }
  }
  private async references(projectId: string, work: Work, sort: string, signal: AbortSignal, notices: string[]): Promise<LinkGroup[]> {
    if (!work.openalex && !work.references?.length) {
      notices.push("OpenAlex 기록이 없어 참고문헌을 조회할 수 없습니다. 서지정보 수정에서 DOI를 넣으면 조회할 수 있습니다.");
      return [];
    }
    const refs = work.references || [];
    if (!refs.length) {
      notices.push("OpenAlex가 이 논문의 참고문헌을 제공하지 않습니다.");
      return [];
    }
    const ids = await this.resolve("openalex", refs, signal);
    const items = this.sorted(this.items(projectId, ids), sort);
    return [{
      key: "references",
      label: "이 논문이 인용한 연구",
      items,
      total: refs.length,
      cursor: null,
      ...(refs.length > items.length ? { note: `OpenAlex에서 찾지 못한 참고문헌 ${refs.length - items.length}편은 빠졌습니다.` } : {}),
    }];
  }
  private async citing(projectId: string, work: Work, sort: string, cursor: string | undefined, signal: AbortSignal, notices: string[]): Promise<LinkGroup[]> {
    if (!work.openalex) {
      notices.push("OpenAlex 기록이 없어 후속 인용을 조회할 수 없습니다. 서지정보 수정에서 DOI를 넣으면 조회할 수 있습니다.");
      return [];
    }
    const groups: LinkGroup[] = [];
    // Papers the user keeps come first: on a widely cited paper they may sit pages deep in OpenAlex.
    const own = cursor ? [] : this.sorted(this.items(projectId, this.citingLocally(work)).filter((w) => w.screening === "included" || w.shelf), sort);
    if (own.length)
      groups.push({ key: "local", label: "내 아카이브·서고에서 인용한 논문", items: own, total: own.length, cursor: null });
    const page = await this.oa.page({
      filter: `cites:${work.openalex}`,
      per_page: CITING_PAGE,
      cursor: cursor || "*",
      sort: sort === "year" ? "publication_date:desc" : "cited_by_count:desc",
    }, signal, this.call);
    const shown = new Set(own.map((w) => w.id));
    groups.push({
      key: "citing",
      label: "OpenAlex 후속 인용",
      items: this.items(projectId, this.store(page.works)).filter((w) => !shown.has(w.id)),
      total: page.total,
      cursor: page.works.length ? page.cursor : null,
    });
    return groups;
  }
  private async related(projectId: string, work: Work, otherFolders: boolean, signal: AbortSignal, notices: string[]): Promise<LinkGroup[]> {
    const shelf = (async (): Promise<LinkGroup | null> => {
      if (!this.shelf?.enabled()) return null;
      try {
        const { hits, notice } = await this.shelf.similar(work.id, SHELF_SIZE, otherFolders, signal);
        if (notice) notices.push(notice);
        const scores = new Map(hits.map((h) => [h.workId, h.score]));
        return { key: "shelf", label: "내 서고에서 비슷한 논문", items: this.items(projectId, hits.map((h) => h.workId), scores), total: null, cursor: null };
      } catch (error) {
        notices.push(`서고에서 비슷한 논문을 찾지 못했습니다 · ${message(error)}`);
        return null;
      }
    })();
    // Provider calls go one after another so they keep the OpenAlex pacing.
    const external = (async () => {
      const groups: LinkGroup[] = [];
      const pmid = pmidOf(work);
      if (this.db.pref<boolean>("linkedDiscoveries") === true && pmid) {
        try {
          const neighborhood = await this.ld.neighbors(pmid, PUBMED_SIZE, signal, () => this.db.usage("linked-discoveries", "links"));
          const scores = new Map<string, number>();
          const ids = await this.resolve("pmid", neighborhood.neighbors.map((n) => n.pmid), signal, (id, value) => {
            const n = neighborhood.neighbors.find((x) => x.pmid === value);
            if (n) scores.set(id, Math.max(scores.get(id) ?? 0, n.score));
          });
          const items = this.items(projectId, ids.filter((id) => id !== work.id), scores)
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          groups.push({ key: "pubmed", label: "PubMed 의미 이웃", items, total: null, cursor: null });
        } catch (error) {
          if (fatal(error)) throw error;
          notices.push(`PubMed 의미 이웃을 가져오지 못했습니다 · ${message(error)}`);
        }
      }
      if (work.related.length) {
        const ids = await this.resolve("openalex", work.related, signal);
        groups.push({ key: "openalex", label: "OpenAlex 관련 논문", items: this.items(projectId, ids.filter((id) => id !== work.id)), total: null, cursor: null });
      }
      return groups;
    })();
    const [own, others] = await Promise.all([shelf, external]);
    const groups = [own, ...others].filter((g): g is LinkGroup => !!g);
    // A paper listed by an earlier source is not listed again.
    const seen = new Set<string>();
    for (const group of groups) {
      group.items = group.items.filter((w) => !seen.has(w.id));
      for (const w of group.items) seen.add(w.id);
    }
    if (!groups.some((g) => g.items.length) && !notices.length)
      notices.push(work.openalex || pmidOf(work)
        ? "제공처가 이 논문의 관련 논문을 알려 주지 않았습니다."
        : "식별자가 없어 관련 논문을 조회할 수 없습니다. 서지정보 수정에서 DOI를 넣으면 조회할 수 있습니다.");
    return groups;
  }
  /** Local works for OpenAlex ids or PMIDs; the ones not stored yet are fetched 100 per call. */
  private async resolve(provider: "openalex" | "pmid", values: string[], signal: AbortSignal, found?: (id: string, value: string) => void): Promise<string[]> {
    const ids = new Map<string, string>();
    const missing: string[] = [];
    for (const value of new Set(values)) {
      const id = this.db.findIdentifier(provider, value);
      if (id) ids.set(value, id);
      else missing.push(value);
    }
    for (const chunk of chunks(missing, 100)) {
      const page = await this.oa.page({ filter: `${provider}:${chunk.join("|")}`, per_page: "100" }, signal, this.call);
      const stored = this.store(page.works);
      page.works.forEach((w, i) => {
        const value = provider === "pmid" ? pmidOf(w) : w.openalex;
        if (value && stored[i]) ids.set(value, stored[i]);
      });
    }
    const result: string[] = [];
    for (const value of values) {
      const id = ids.get(value);
      if (!id) continue;
      found?.(id, value);
      if (!result.includes(id)) result.push(id);
    }
    return result;
  }
  /** Stores fetched papers without touching a project; a paper already stored keeps its record and edits. */
  private store(works: Work[]): string[] {
    return this.db.transaction(() =>
      works.map((w) => {
        const known = w.openalex ? this.db.findIdentifier("openalex", w.openalex) : undefined;
        if (known) return known;
        try {
          return this.db.upsert(w).work.id;
        } catch (error) {
          if (error instanceof AppError && error.code === "IDENTITY_CONFLICT") return "";
          throw error;
        }
      }),
    );
  }
  /** Stored papers whose references name this one; the citations table needs no API call. */
  private citingLocally(work: Work): string[] {
    const rows = this.db.db
      .prepare("SELECT DISTINCT citing_id AS id FROM citations WHERE cited_external=? AND citing_id!=?")
      .all(work.openalex, work.id) as { id: string }[];
    return rows.map((r) => r.id);
  }
  private items(projectId: string, ids: string[], scores?: Map<string, number>): LinkedWork[] {
    return this.db.views(projectId, ids.filter(Boolean))
      .map((w) => ({
        id: w.id,
        title: w.title,
        authors: w.authors.slice(0, 3),
        authorCount: w.authors.length,
        year: w.year,
        venue: w.venue,
        citations: w.citations,
        doi: w.doi,
        screening: w.state.screening,
        shelf: w.shelf?.folder ?? null,
        score: scores?.get(w.id) ?? null,
      }));
  }
  private sorted(items: LinkedWork[], sort: string): LinkedWork[] {
    const year = (w: LinkedWork) => w.year ?? -Infinity, cited = (w: LinkedWork) => w.citations ?? -1;
    return [...items].sort((a, b) =>
      sort === "year" ? year(b) - year(a) || cited(b) - cited(a) : cited(b) - cited(a) || year(b) - year(a));
  }
}
