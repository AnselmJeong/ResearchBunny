import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { version } from "../../../package.json";
import { AppError, now, type LinkedNeighbor, type LinkedSize } from "../../shared/types";
import { normalizePmid } from "../../shared/domain";
import type { Library } from "../db/database";

export type { LinkedNeighbor } from "../../shared/types";
export interface LinkedNeighborhood {
  seedPmid: string;
  neighbors: LinkedNeighbor[];
  entities: { diseases: Record<string, string>; genes: Record<string, string>; chemicals: Record<string, string> };
  cached: boolean;
  fetchedAt: string;
}
const BASE = "https://linkeddiscoveries.ncbi.nlm.nih.gov";
const COOKIE = "linked-discoveries-csrftoken";
const strings = z.array(z.string()).catch([]);
const dictionary = z.record(z.string(), z.string()).catch({});
const schema = z.object({
  articles: z.array(z.object({
    articleId: z.string().regex(/^[1-9]\d*$/),
    score: z.number().min(0).max(1),
    isSeed: z.boolean(),
    isReview: z.boolean().catch(false),
    isRetracted: z.boolean().catch(false),
    diseases: strings,
    genes: strings,
    chemicals: strings,
  }).passthrough()),
  diseases: dictionary,
  genes: dictionary,
  chemicals: dictionary,
}).passthrough();

// Shared across provider instances. Hold the slot until the body has been read.
let queue = Promise.resolve();
let nextRequestAt = 0;
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AppError("CANCELLED", "작업이 취소되었습니다."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class LinkedDiscoveries {
  private token: string | undefined;
  constructor(
    private library: Library,
    private fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
  ) {}
  private async request(pmid: string, size: LinkedSize | undefined, signal: AbortSignal, onCall: () => void) {
    const job = queue.then(async () => {
      signal.throwIfAborted();
      await delay(Math.max(0, nextRequestAt - Date.now()), undefined, { signal });
      signal.throwIfAborted();
      onCall();
      nextRequestAt = Date.now() + 1000;
      const response = await this.fetcher(`${BASE}/${pmid}/${size ? "links/" : ""}`, {
        method: size ? "POST" : "GET",
        headers: {
          "User-Agent": `ResearchBunny/${version} (literature discovery desktop app)`,
          ...(size ? {
            Cookie: `${COOKIE}=${this.token}`,
            "X-CSRFToken": this.token!,
            "Content-Type": "application/x-www-form-urlencoded",
          } : {}),
        },
        body: size ? `neighbors=${size}` : undefined,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        redirect: "error",
      });
      const body = await response.text();
      return { status: response.status, headers: response.headers, body };
    });
    queue = job.then(() => {}, () => {});
    return abortable(job, signal);
  }
  private async retry(pmid: string, size: LinkedSize | undefined, signal: AbortSignal, onCall: () => void) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(pmid, size, signal, onCall);
        if (response.status === 429)
          throw new AppError("RATE_LIMIT", "PubMed 의미 이웃 요청 한도입니다. 잠시 후 재개하세요.", true);
        if (response.status >= 500 && attempt < 2) continue;
        return response;
      } catch (error) {
        if (signal.aborted) throw new AppError("CANCELLED", "작업이 취소되었습니다.");
        if (error instanceof AppError) throw error;
        if (attempt < 2) continue;
        throw new AppError("NETWORK", "PubMed 의미 이웃에 연결하지 못했습니다.", true);
      }
    }
  }
  private checkStatus(status: number) {
    if (status < 200 || status >= 300)
      throw new AppError(status === 404 ? "NOT_FOUND" : "PROVIDER", `PubMed 의미 이웃 요청 실패 (${status}).`, status >= 500);
  }
  async neighbors(pmid: string, size: LinkedSize, signal: AbortSignal, onCall: () => void): Promise<LinkedNeighborhood> {
    signal.throwIfAborted();
    const normalized = normalizePmid(pmid);
    if (!normalized || ![20, 50, 100, 200].includes(size))
      throw new AppError("INVALID", "PMID와 이웃 개수를 확인하세요.");
    pmid = normalized;
    const key = `ld:v1:${pmid}:${size}`;
    const cached = this.library.cacheGet(key) as LinkedNeighborhood | undefined;
    if (cached) return { ...cached, cached: true };
    for (let refresh = 0; refresh < 2; refresh++) {
      if (!this.token) {
        const session = await this.retry(pmid, undefined, signal, onCall);
        this.checkStatus(session.status);
        this.token = session.headers.get("set-cookie")?.match(/(?:^|[,;]\s*)linked-discoveries-csrftoken=([A-Za-z0-9]+)/)?.[1];
        if (!this.token) throw new AppError("PROVIDER_SCHEMA", "PubMed 의미 이웃 세션을 확인하지 못했습니다.");
      }
      const response = await this.retry(pmid, size, signal, onCall);
      if (response.status === 403) {
        this.token = undefined;
        if (refresh === 0) continue;
      }
      this.checkStatus(response.status);
      let raw: unknown;
      try { raw = JSON.parse(response.body); }
      catch { throw new AppError("PROVIDER_SCHEMA", "PubMed 의미 이웃 응답을 해석하지 못했습니다."); }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new AppError("PROVIDER_SCHEMA", "PubMed 의미 이웃 응답 형식이 바뀌었습니다.");
      const { articles, diseases, genes, chemicals } = parsed.data;
      const neighbors = new Map<string, LinkedNeighbor>();
      for (const article of articles) {
        if (article.isSeed || article.articleId === pmid) continue;
        const previous = neighbors.get(article.articleId);
        if (previous && previous.score >= article.score) continue;
        neighbors.set(article.articleId, {
          pmid: article.articleId, score: article.score,
          isReview: article.isReview, isRetracted: article.isRetracted,
          diseases: article.diseases, genes: article.genes, chemicals: article.chemicals,
        });
      }
      const result: LinkedNeighborhood = {
        seedPmid: pmid,
        neighbors: [...neighbors.values()].sort((a, b) => b.score - a.score),
        entities: { diseases, genes, chemicals }, cached: false, fetchedAt: now(),
      };
      // Store only identifiers and evidence, never article text from this service.
      this.library.cacheSet(key, result, 7 * 86400000);
      return result;
    }
    throw new AppError("PROVIDER", "PubMed 의미 이웃 세션 갱신에 실패했습니다.");
  }
}
