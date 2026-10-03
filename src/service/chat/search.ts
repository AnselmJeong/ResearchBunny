import type { ChatSource } from "../../shared/chat";
import { safeWebUrl } from "../../shared/domain";
import { searchScholarlyEvidence, mergeScholarlyResults } from "../search/scholarly-search";
import { searchAndFetchWebWithTinyFish, type FetchLike } from "../search/web-search";

export interface SearchKeys { openalex?: string; pubmed?: string; tinyfish?: string }
export async function searchEvidence(query: string, keys: SearchKeys, signal: AbortSignal, fetchFn: FetchLike = fetch): Promise<{ sources: ChatSource[]; notice: string }> {
  const warnings: string[] = [];
  let scholarly: ChatSource[] = [];
  let web: ChatSource[] = [];
  try {
    scholarly = await searchScholarlyEvidence(query, 5, { openAlexApiKey: keys.openalex, ncbiApiKey: keys.pubmed, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]), fetchFn, onWarning: m => warnings.push(m) });
  } catch {
    signal.throwIfAborted();
    warnings.push("OpenAlex·PubMed 검색을 완료하지 못했습니다.");
  }
  if (scholarly.length < 3 && keys.tinyfish) {
    try {
      web = await searchAndFetchWebWithTinyFish(`${query} (site:pubmed.ncbi.nlm.nih.gov OR site:openalex.org OR site:doi.org)`, { tinyfishApiKey: keys.tinyfish, webSearchEnabled: true }, 3, AbortSignal.any([signal, AbortSignal.timeout(60000)]), fetchFn);
      web = web.map(s => ({ ...s, source: "web" }));
    } catch {
      signal.throwIfAborted();
      warnings.push("TinyFish 보완 검색을 완료하지 못했습니다.");
    }
  }
  signal.throwIfAborted();
  const sources = mergeScholarlyResults(scholarly, web, 6).filter(s => safeWebUrl(s.url)).map(s => ({ ...s, title: s.title.slice(0, 600), content: s.content.slice(0, 2400) }));
  if (!sources.length) warnings.push("외부 근거를 확보하지 못했습니다. 선택한 문헌의 정보만 사용합니다.");
  return { sources, notice: [...new Set(warnings)].join(" ") };
}
