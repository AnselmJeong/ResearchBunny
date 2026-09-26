import { z } from "zod";
import { createHash } from "node:crypto";
import { AppError, now, type Work } from "../../shared/types";
import {
  blankWork,
  normalizeDoi,
  normalizeOpenAlex,
  restoreAbstract,
  safeWebUrl,
} from "../../shared/domain";
import type { Library } from "../db/database";
const rawSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    doi: z.string().nullable().optional(),
    publication_year: z.number().nullable().optional(),
    type: z.string().optional(),
    cited_by_count: z.number().nonnegative().nullable().optional(),
    authorships: z
      .array(
        z
          .object({
            author: z
              .object({ display_name: z.string().nullable().optional() })
              .passthrough(),
          })
          .passthrough(),
      )
      .optional(),
    referenced_works: z.array(z.string()).nullable().optional(),
    related_works: z.array(z.string()).nullable().optional(),
    topics: z
      .array(
        z.object({ id: z.string(), display_name: z.string() }).passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();
export function fromOpenAlex(input: unknown): Work {
  const r = rawSchema.parse(input);
  const oa = normalizeOpenAlex(r.id);
  if (!oa)
    throw new AppError(
      "PROVIDER_SCHEMA",
      "OpenAlex 식별자 형식이 올바르지 않습니다.",
    );
  const p = r.primary_location as any,
    b = r.biblio as any,
    o = r.best_oa_location as any;
  return blankWork({
    openalex: oa,
    doi: normalizeDoi(r.doi),
    title: r.title || r.display_name || "제목 미확인",
    authors: (r.authorships || []).map(
      (a) => a.author.display_name || "이름 미상",
    ),
    year: r.publication_year ?? null,
    type: r.type || "article",
    abstract: restoreAbstract(r.abstract_inverted_index),
    citations: r.cited_by_count ?? null,
    references:
      r.referenced_works
        ?.map(normalizeOpenAlex)
        .filter((x): x is string => !!x) ?? null,
    related:
      r.related_works?.map(normalizeOpenAlex).filter((x): x is string => !!x) ||
      [],
    topics: (r.topics || []).map((t) => ({ id: t.id, name: t.display_name })),
    venue: p?.source?.display_name || "",
    url: safeWebUrl(p?.landing_page_url) || `https://openalex.org/${oa}`,
    oaUrl: safeWebUrl(
      o?.pdf_url || o?.landing_page_url || (r.open_access as any)?.oa_url,
    ),
    retracted: r.is_retracted === true,
    volume: b?.volume || "",
    issue: b?.issue || "",
    pages: [b?.first_page, b?.last_page].filter(Boolean).join("--"),
    publisher: p?.source?.host_organization_name || "",
    source: "openalex",
    raw: r,
    fetchedAt: now(),
  });
}
export interface Page {
  works: Work[];
  cursor: string | null;
  total: number | null;
  cached: boolean;
  fetchedAt: string;
}
export class OpenAlex {
  lastRequest = 0;
  constructor(
    private library: Library,
    private key: () => string | undefined,
    private fetcher: typeof fetch = fetch,
  ) {}
  async request(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal,
    onCall: () => void,
  ): Promise<{ data: any; cached: boolean; fetchedAt: string }> {
    const url = new URL(`https://api.openalex.org/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const cacheKey =
      "oa:v1:" + createHash("sha256").update(url.href).digest("hex");
    const cache = this.library.cacheGet(cacheKey) as
      { data: unknown; fetchedAt: string } | undefined;
    if (cache) return { ...cache, cached: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const delay = Math.max(
        0,
        this.lastRequest +
          (params["search.semantic"] ? 1100 : 150) -
          Date.now(),
      );
      if (delay)
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, delay);
          const abort = () => {
            clearTimeout(t);
            reject(new AppError("CANCELLED", "작업이 취소되었습니다."));
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      signal.throwIfAborted();
      onCall();
      this.lastRequest = Date.now();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: this.key() ? { Authorization: `Bearer ${this.key()}` } : {},
          signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
          redirect: "error",
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (attempt < 2) continue;
        throw new AppError(
          "NETWORK",
          "OpenAlex에 연결하지 못했습니다. 인터넷 연결을 확인하고 재개하세요.",
          true,
        );
      }
      if (response.status === 429) {
        const budget = response.headers.get("x-ratelimit-remaining");
        throw new AppError(
          budget === "0" ? "DAILY_BUDGET" : "RATE_LIMIT",
          budget === "0"
            ? "OpenAlex 일일 예산을 소진했습니다. 사용량 초기화 후 재개하세요."
            : `OpenAlex 요청 한도입니다. ${response.headers.get("retry-after") || "60"}초 후 재개하세요.`,
          true,
        );
      }
      if (response.status === 401 || response.status === 403)
        throw new AppError(
          "API_KEY",
          "OpenAlex API 키를 확인하세요. 설정에서 무료 키를 등록할 수 있습니다.",
        );
      if (response.status === 404)
        throw new AppError(
          "NOT_FOUND",
          "OpenAlex에서 이 문헌을 찾지 못했습니다.",
        );
      if (response.status >= 500 && attempt < 2) continue;
      if (!response.ok)
        throw new AppError(
          "PROVIDER",
          `OpenAlex 요청 실패 (${response.status}). 검색 조건을 확인하세요.`,
          response.status >= 500,
        );
      const data = await response.json();
      const fetchedAt = now();
      this.library.cacheSet(
        cacheKey,
        { data, fetchedAt },
        path.startsWith("works/") ? 7 * 86400000 : 6 * 3600000,
      );
      return { data, cached: false, fetchedAt };
    }
    throw new AppError("NETWORK", "OpenAlex 요청을 완료하지 못했습니다.", true);
  }
  async lookup(
    identifier: string,
    signal: AbortSignal,
    onCall: () => void,
  ): Promise<Page> {
    const id = normalizeOpenAlex(identifier) || normalizeDoi(identifier);
    if (!id)
      throw new AppError("INVALID", "DOI 또는 OpenAlex ID가 필요합니다.");
    const path = normalizeOpenAlex(identifier)
      ? `works/${id}`
      : `works/https://doi.org/${id.split("/").map(encodeURIComponent).join("/")}`;
    const r = await this.request(path, {}, signal, onCall);
    return {
      works: [fromOpenAlex(r.data)],
      cursor: null,
      total: 1,
      cached: r.cached,
      fetchedAt: r.fetchedAt,
    };
  }
  async page(
    params: Record<string, string>,
    signal: AbortSignal,
    onCall: () => void,
  ): Promise<Page> {
    const r = await this.request(
      "works",
      { per_page: "50", ...params },
      signal,
      onCall,
    );
    if (!Array.isArray(r.data.results))
      throw new AppError(
        "PROVIDER_SCHEMA",
        "OpenAlex 검색 응답을 해석하지 못했습니다.",
      );
    return {
      works: r.data.results.map(fromOpenAlex),
      cursor: r.data.meta?.next_cursor || null,
      total: typeof r.data.meta?.count === "number" ? r.data.meta.count : null,
      cached: r.cached,
      fetchedAt: r.fetchedAt,
    };
  }
}
