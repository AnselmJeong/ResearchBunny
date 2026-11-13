import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeDoi, titleSimilarity } from "../../shared/domain";
import { AppError, type Work } from "../../shared/types";

// Ported from Article_Downloader/downloader.py: DOI cleanup/Crossref lookup,
// Unpaywall candidate ordering, publisher URL rules and PDF-link discovery.
// This module deliberately has no BibTeX, terminal, Python or Chrome-profile dependency.
export type DownloadFetch = (url: string, init?: RequestInit) => Promise<Response>;
const MAX_PDF_BYTES = 150 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const email = process.env.RESEARCHBUNNY_UNPAYWALL_EMAIL || "anselmjeong@gmail.com";
const headers = { "User-Agent": `ResearchBunny/0.2 (mailto:${email})` };

export function cleanDoi(value: unknown) {
  return typeof value === "string"
    ? normalizeDoi(value.replace(/\\textunderscore/g, "_").replace(/[{}]/g, "").replace(/\\([_%&#$~])/g, "$1"))
    : null;
}
export function isBook(work: Work) {
  return /^(book|book-chapter|inbook|incollection|booklet|mvbook|bookinbook|collection|reference)$/.test(work.type) ||
    !!work.doi?.match(/^10\.\d{4,9}\/b?97[89][-\d]/i);
}
export function publicUrl(value: unknown, base?: string): string | null {
  if (typeof value !== "string" || value.length > 16000) return null;
  try {
    const u = new URL(value, base);
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) return null;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".")) return null;
    if (isIP(host) && !publicAddress(host)) return null;
    u.hash = "";
    return u.href;
  } catch { return null; }
}
function publicAddress(ip: string) {
  // IPv6 destinations are limited to global unicast; IPv4-mapped addresses are excluded.
  if (isIP(ip) === 6) return /^[23][0-9a-f]{3}:/i.test(ip) && !/^2001:db8:/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && [0, 168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19].includes(b));
}
async function checkAddress(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new AppError("DOWNLOAD_URL", "로컬·사설 네트워크 주소는 다운로드하지 않습니다.");
}
const urls = (values: unknown[]) => [...new Set(values.map(v => publicUrl(v)).filter((v): v is string => !!v))];
export function unpaywallUrls(data: any) {
  return urls([data?.best_oa_location?.url_for_pdf, ...(Array.isArray(data?.oa_locations) ? data.oa_locations.map((l: any) => l?.url_for_pdf) : [])]);
}
export function publisherPdfUrls(value: string): string[] {
  const rules: [RegExp, string][] = [
    [/^(https?:\/\/(?![^/]*wiley\.com)[^/]+)\/doi\/(?:full|abs|epub|reader|epdf)\/(10\.[^?#]+)/, "$1/doi/pdf/$2?download=true"],
    [/^(https?:\/\/[^/]*onlinelibrary\.wiley\.com)\/doi\/(?:full\/|abs\/|epdf\/|pdf\/)?(10\.[^?#]+)/, "$1/doi/pdfdirect/$2?download=true"],
    [/^(https?:\/\/(?:www\.)?sciencedirect\.com\/science\/article)\/(?:abs\/)?pii\/([A-Z0-9]+)/, "$1/pii/$2/pdfft?isDTMRedir=true&download=true"],
    [/^https?:\/\/linkinghub\.elsevier\.com\/retrieve\/pii\/([A-Z0-9]+)/, "https://www.sciencedirect.com/science/article/pii/$1/pdfft?isDTMRedir=true&download=true"],
    [/^(https?:\/\/link\.springer\.com)\/(?:(?:article|chapter|referenceworkentry|rwe)\/)?(10\.[^?#]+)/, "$1/content/pdf/$2.pdf"],
    [/^(https?:\/\/(?:www\.)?nature\.com\/articles\/[^/?#.]+)/, "$1.pdf"],
    [/^(https?:\/\/(?:www\.)?mdpi\.com\/[\d-]+\/\d+\/\d+\/\d+)\/?(?:htm)?$/, "$1/pdf"],
    [/^(https?:\/\/(?:www\.)?frontiersin\.org\/(?:journals\/[^/]+\/)?articles\/10\.[^/]+\/[^/?#]+)\/full/, "$1/pdf"],
    [/^(https?:\/\/journals\.plos\.org\/[^/]+)\/article\?id=(10\.[^&#]+)/, "$1/article/file?id=$2&type=printable"],
  ];
  return urls(rules.filter(([r]) => r.test(value)).map(([r, replacement]) => value.replace(new RegExp(r.source + ".*$", r.flags), replacement)));
}
function decodeHtml(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) => {
      const code = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}
function tagAttrs(tag: string) {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))
    attrs[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4]);
  return attrs;
}
export function htmlPdfUrls(html: string, base: string) {
  const found: unknown[] = [];
  for (const tag of html.match(/<(?:meta|a|iframe|embed|object)\b[^>]*>/gi) || []) {
    const attrs = tagAttrs(tag);
    const href = attrs.href || attrs.src || attrs.data;
    if ((attrs.name || attrs.property || "").toLowerCase() === "citation_pdf_url") found.push(publicUrl(attrs.content, base));
    if (href && /\.pdf(?:[?/#]|$)|article-pdf|\/pdf(?:direct)?[/?]/i.test(href)) found.push(publicUrl(href, base));
  }
  return urls(found).slice(0, 8);
}
async function readLimited(response: Response, limit: number, signal: AbortSignal) {
  if (!response.body) throw new AppError("DOWNLOAD_EMPTY", "서버가 빈 응답을 반환했습니다.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await untilAborted(reader.read(), signal);
      if (done) break;
      size += value.length;
      if (size > limit) throw new AppError("DOWNLOAD_SIZE", "응답 크기 제한을 초과했습니다.");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { void reader.cancel().catch(() => {}); }
}
// DNS and body readers do not always honor the fetch AbortSignal. Bound the
// awaited operation as well, so one server cannot hold the batch indefinitely.
export function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once:true});
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export interface RetrievedPdf {
  sourceUrl: string; doi: string | null; version?: string; requireIdentity?: boolean; method?: "chrome" | "http";
  /** The Sci-Hub mirror host the PDF came through. */
  mirror?: string;
}
export const DEFAULT_SCIHUB_MIRRORS = ["https://sci-hub.kr"];
/** Mirror origins as typed in settings ("sci-hub.kr", "https://sci-hub.kr/"), deduplicated. */
export function sciHubMirrors(values: unknown): string[] {
  const mirrors = (Array.isArray(values) ? values : []).map(value => {
    const text = typeof value === "string" ? value.trim() : "";
    const url = text && publicUrl(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!url) throw new AppError("SCIHUB_MIRROR", `Sci-Hub 미러 주소를 확인하세요: ${text || "(빈 값)"}`);
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, "");
  });
  return [...new Set(mirrors)].slice(0, 5);
}
/** The mirror's page for a DOI, in the `<mirror>/https://doi.org/<doi>` form. */
export function sciHubUrl(mirror: string, doi: string) {
  return `${mirror}/https://doi.org/${encodeURI(doi).replace(/[?#]/g, c => encodeURIComponent(c))}`;
}
// Mirrors sit behind bot guards (DDoS-Guard), so they get a browser's request: no app name and no
// contact address, which the other routes send to Unpaywall and publishers.
const BROWSER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export function sciHubHeaders(referer?: string): Record<string, string> {
  return {
    "User-Agent": BROWSER_AGENT,
    Accept: referer ? "application/pdf,*/*;q=0.8" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    ...(referer ? { Referer: referer } : {}),
  };
}
/**
 * The cookies mirrors set (DDoS-Guard's `__ddg*`, the PHP session), sent back the way a
 * browser would, so later requests look like the same visitor. In memory only.
 */
export class CookieJar {
  private cookies = new Map<string, { name: string; value: string; domain: string; hostOnly: boolean; expires: number }>();
  store(url: string, headers: Headers) {
    const host = new URL(url).hostname.toLowerCase(), now = Date.now();
    for (const line of headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, hostOnly: true, expires: Infinity };
      let maxAge = false, foreign = false;
      for (const attr of attrs) {
        const at = attr.indexOf("="), key = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase(), value = at < 0 ? "" : attr.slice(at + 1).trim();
        if (key === "domain" && value) {
          const domain = value.replace(/^\./, "").toLowerCase();
          // A cookie for another site, or for a whole top-level domain, is refused as a browser would.
          if (!domain.includes(".") || (host !== domain && !host.endsWith(`.${domain}`))) foreign = true;
          Object.assign(cookie, { domain, hostOnly: false });
        } else if (key === "max-age" && /^-?\d+$/.test(value)) { cookie.expires = now + Number(value) * 1000; maxAge = true; }
        else if (key === "expires" && !maxAge && !Number.isNaN(Date.parse(value))) cookie.expires = Date.parse(value);
      }
      const key = `${cookie.domain}\t${cookie.name}`;
      if (foreign) continue;
      if (cookie.expires <= now) this.cookies.delete(key);
      else if (this.cookies.has(key) || this.cookies.size < 200) this.cookies.set(key, cookie);
    }
  }
  header(url: string) {
    const host = new URL(url).hostname.toLowerCase(), now = Date.now();
    return [...this.cookies.values()]
      .filter(c => c.expires > now && (host === c.domain || (!c.hostOnly && host.endsWith(`.${c.domain}`))))
      .map(c => `${c.name}=${c.value}`).join("; ");
  }
}
/**
 * Where a mirror's article page keeps the PDF: its citation tag, the embedded viewer, a
 * download link or a button's `location.href`. Embeds without a `.pdf` address come last.
 */
export function sciHubPdfUrls(html: string, base: string) {
  const found: unknown[] = [...htmlPdfUrls(html, base)], embeds: unknown[] = [];
  for (const tag of html.match(/<(?:iframe|embed|object|button|div|a)\b[^>]*>/gi) || []) {
    const attrs = tagAttrs(tag);
    const src = /^<(?:iframe|embed|object)/i.test(tag) ? attrs.src || attrs.data : undefined;
    if (src) (attrs.type === "application/pdf" || /\.pdf(?:[?#]|$)/i.test(src) ? found : embeds).push(publicUrl(src, base));
    const onclick = /location\.href\s*=\s*['"]([^'"]+)['"]/.exec(attrs.onclick || "")?.[1];
    if (onclick) found.push(publicUrl(onclick, base));
  }
  const page = publicUrl(base);
  return urls([...found, ...embeds]).filter(url => url !== page).slice(0, 4);
}
// DDoS-Guard's ALTCHA page (sci-hub.kr), Cloudflare, reCAPTCHA, hCaptcha and Turnstile.
const CHALLENGE = /<altcha-widget\b|<title[^>]*>\s*(?:ddos-guard|로봇 확인|just a moment|attention required|security check)|captcha required|verify (?:that )?you are (?:a )?human|g-recaptcha-response|h-captcha-response|cf-turnstile-response|\/cdn-cgi\/challenge-platform\/|\b(?:id|name)\s*=\s*["']captcha["']/i;
/** A robot check rather than an article: the article page also carries an ALTCHA form, but with its PDF. */
export function sciHubChallenge(html: string, headers?: Headers) {
  return headers?.get("cf-mitigated")?.toLowerCase() === "challenge" ||
    (CHALLENGE.test(html) && !htmlPdfUrls(html, "https://mirror.invalid/").length);
}
/** The mirror's own "no such article" page (sci-hub.kr answers 404 `페이지를 찾을 수 없습니다`). */
export function sciHubMissing(html: string) {
  const text = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  return /not found|찾을 수 없|не найден|отсутствует/i.test(text);
}
/** A failed Sci-Hub attempt. `page` is set when a person could finish it in Chrome (robot check, blocked mirror, a page without a PDF link). */
export class SciHubError extends AppError {
  constructor(code: string, message: string, public page?: string) { super(code, message); }
}
// Which failure to report when every mirror failed: the one a person can act on first.
const SCIHUB_RANK: Record<string, number> = {
  SCIHUB_CHALLENGE: 6, SCIHUB_BLOCKED: 5, SCIHUB_RATE_LIMITED: 4, SCIHUB_NO_LINK: 3, SCIHUB_NOT_PDF: 3, SCIHUB_MISSING: 1,
};
const sciHubRank = (error: SciHubError) => SCIHUB_RANK[error.code] ?? 2;
// A guard that stopped one request from a mirror stops the rest of that mirror's links too.
const SCIHUB_GUARDED = new Set(["SCIHUB_CHALLENGE", "SCIHUB_BLOCKED", "SCIHUB_RATE_LIMITED"]);
type HtmlFetched = { kind: "html"; url: string; html: string; status: number; headers: Headers };
type Fetched = { kind: "pdf"; url: string } | HtmlFetched;
/** Why a mirror answered with a page instead of the PDF, or null for an ordinary page. */
function sciHubRefusal(fetched: HtmlFetched, host: string, page: string): SciHubError | null {
  const where = `Sci-Hub 미러(${host})`, status = fetched.status;
  if (sciHubChallenge(fetched.html, fetched.headers))
    return new SciHubError("SCIHUB_CHALLENGE", `${where}가 로봇 확인을 요구합니다. Chrome에서 확인을 마치면 내려받을 수 있습니다.`, page);
  if (status === 401 || status === 403) return new SciHubError("SCIHUB_BLOCKED", `${where}가 접근을 막았습니다 (HTTP ${status}).`, page);
  if (status === 429) {
    const after = fetched.headers.get("retry-after");
    return new SciHubError("SCIHUB_RATE_LIMITED", `${where}가 요청이 많다며 잠시 거절했습니다 (HTTP 429${after ? ` · Retry-After ${after.slice(0, 40)}` : ""}).`);
  }
  if (status === 404 || status === 410) return new SciHubError("SCIHUB_MISSING", `${where}에 이 논문의 PDF가 없습니다.`);
  if (status >= 400) return new SciHubError("SCIHUB_UNAVAILABLE", `${where} 응답 오류 (HTTP ${status}).`);
  return null;
}
type RequestOptions = {
  requestMs?: number; headers?: Record<string, string>; cookies?: CookieJar;
  /** Return error responses instead of throwing, so their page can be read (a robot check sent with 403). */
  acceptStatus?: boolean;
};
// Sci-Hub serves whole scanned volumes (30 MB+), so its PDF requests get a longer bound.
const LIMITS = {requestMs:15000, itemMs:90000, sciHubMs:120000, sciHubPdfMs:60000};
export class FulltextEngine {
  private limits: typeof LIMITS;
  constructor(
    private fetcher: DownloadFetch = fetch,
    private networkCheck: (url: string) => Promise<void> = checkAddress,
    limits: Partial<typeof LIMITS> = {},
  ) { this.limits = {...LIMITS, ...limits}; }
  /** Mirror cookies, kept for the app's lifetime like a browser session. */
  private sciHubCookies = new CookieJar();
  private async request(value: string, signal: AbortSignal, options: RequestOptions = {}): Promise<{response:Response; signal:AbortSignal}> {
    let url = publicUrl(value);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.requestMs ?? this.limits.requestMs)]);
    for (let i = 0; url && i < 6; i++) {
      requestSignal.throwIfAborted();
      await untilAborted(this.networkCheck(url), requestSignal);
      requestSignal.throwIfAborted();
      const cookie = options.cookies?.header(url);
      const response = await untilAborted(this.fetcher(url, {
        headers: { ...(options.headers ?? headers), ...(cookie ? { Cookie: cookie } : {}) }, signal: requestSignal, redirect: "manual",
      }), requestSignal);
      options.cookies?.store(url, response.headers);
      if (response.status >= 300 && response.status < 400) {
        const next = publicUrl(response.headers.get("location"), url);
        void response.body?.cancel().catch(() => {});
        url = next;
        continue;
      }
      if (!response.ok && !options.acceptStatus) {
        void response.body?.cancel().catch(() => {});
        throw new AppError("DOWNLOAD_HTTP", response.status === 401 || response.status === 403
          ? `로그인·접근 권한 또는 사람 인증이 필요합니다 (HTTP ${response.status}).`
          : `원문 서버 응답 오류 (HTTP ${response.status}).`);
      }
      // Mock responses may have no URL; resolve relative PDF links against the final request.
      if (!response.url) Object.defineProperty(response, "url", { value: url });
      return {response, signal:requestSignal};
    }
    throw new AppError("DOWNLOAD_REDIRECT", "안전한 원문 주소를 찾지 못했거나 리디렉션이 너무 많습니다.");
  }
  /** Stream a PDF response to `path`; any other response (and, with `acceptStatus`, any error) comes back as its first 2MB of HTML. */
  private async fetchCandidate(url: string, path: string, signal: AbortSignal, options?: RequestOptions): Promise<Fetched> {
    const {response, signal:requestSignal} = await this.request(url, signal, options);
    const reader = response.body?.getReader();
    if (!reader) throw new AppError("DOWNLOAD_EMPTY", "원문 응답이 비어 있습니다.");
    const prefix: Uint8Array[] = [];
    let size = 0;
    let ended = false;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      while (size < 1024) {
        const chunk = await untilAborted(reader.read(), requestSignal);
        if (chunk.done) { ended = true; break; }
        size += chunk.value.length;
        prefix.push(chunk.value);
        if (size > MAX_PDF_BYTES) throw new AppError("DOWNLOAD_SIZE", "PDF가 150MB 제한을 초과했습니다.");
      }
      const head = Buffer.concat(prefix);
      if (!response.ok || !head.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
        const parts = [head];
        while (!ended && size <= MAX_HTML_BYTES) {
          signal.throwIfAborted();
          const chunk = await untilAborted(reader.read(), requestSignal);
          if (chunk.done) break;
          size += chunk.value.length;
          if (size <= MAX_HTML_BYTES) parts.push(Buffer.from(chunk.value));
        }
        return { kind: "html", url: response.url, html: Buffer.concat(parts).toString("utf8"), status: response.status, headers: response.headers };
      }
      const length = Number(response.headers.get("content-length"));
      if (length > MAX_PDF_BYTES) throw new AppError("DOWNLOAD_SIZE", "PDF가 150MB 제한을 초과했습니다.");
      file = await open(path, "w", 0o600);
      await file.writeFile(head);
      while (!ended) {
        signal.throwIfAborted();
        const chunk = await untilAborted(reader.read(), requestSignal);
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_PDF_BYTES) throw new AppError("DOWNLOAD_SIZE", "PDF가 150MB 제한을 초과했습니다.");
        await file.writeFile(chunk.value);
      }
      await file.sync();
      await file.close();
      file = undefined;
      return { kind: "pdf", url: response.url };
    } finally { void reader.cancel().catch(() => {}); await file?.close(); }
  }
  private async json(url: string, signal: AbortSignal) {
    for (let i = 0; i < 2; i++) {
      try {
        const {response, signal:requestSignal} = await this.request(url, signal);
        return JSON.parse((await readLimited(response, MAX_HTML_BYTES, requestSignal)).toString("utf8"));
      } catch (error) {
        signal.throwIfAborted();
        if (i) throw error;
        await delay(600, undefined, { signal });
      }
    }
  }
  async lookupDoi(work: Work, signal: AbortSignal): Promise<string | null> {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query.bibliographic", work.title);
    url.searchParams.set("rows", "5");
    const data = await this.json(url.href, signal);
    const candidates = (Array.isArray(data?.message?.items) ? data.message.items : []).map((item: any) => {
      const score = titleSimilarity(work.title, String(item.title?.[0] || ""));
      const year = item.issued?.["date-parts"]?.[0]?.[0];
      const author = String(item.author?.[0]?.family || "").toLocaleLowerCase();
      const authorMatches = !!author && !!work.authors[0]?.toLocaleLowerCase().includes(author);
      const yearMatches = work.year === null || !year || Math.abs(work.year - year) <= 1;
      return { doi: cleanDoi(item.DOI), score, confident: score >= 0.9 && yearMatches && (!work.authors.length || authorMatches) };
    }).filter((c: any) => c.doi && c.confident).sort((a: any, b: any) => b.score - a.score);
    // Ambiguous metadata is safer to leave for review than to attach another paper's PDF.
    return candidates.length && (candidates.length === 1 || candidates[0].score - candidates[1].score >= 0.08) ? candidates[0].doi : null;
  }
  async retrieve(work: Work, path: string, signal: AbortSignal, progress: (message: string) => void,
    validate?: (retrieved: RetrievedPdf) => Promise<void>): Promise<RetrievedPdf> {
    const itemSignal = AbortSignal.any([signal, AbortSignal.timeout(this.limits.itemMs)]);
    let doi = cleanDoi(work.doi);
    const raw = work.raw as any;
    const locations = [raw?.best_oa_location, ...(Array.isArray(raw?.locations) ? raw.locations : [])];
    const queue = urls([work.oaUrl, ...locations.map((l: any) => l?.pdf_url)]);
    const landings = urls([work.url, ...locations.map((l: any) => l?.landing_page_url)]).slice(0, 3);
    const tried = new Set<string>();
    let lastError: unknown;
    const tryUrl = async (url: string): Promise<RetrievedPdf | null> => {
      if (tried.has(url) || tried.size >= 12) return null;
      tried.add(url);
      progress(`원문 확인 · ${new URL(url).hostname}`);
      try {
        const fetched = await this.fetchCandidate(url, path, itemSignal);
        if (fetched.kind === "html") {
          queue.push(...urls([...htmlPdfUrls(fetched.html, fetched.url), ...publisherPdfUrls(fetched.url)]));
          throw new AppError("DOWNLOAD_NOT_PDF", "PDF 대신 안내·로그인 페이지가 반환되었습니다.");
        }
        const version = locations.find((l: any) => l?.pdf_url === url)?.version;
        const retrieved: RetrievedPdf = { sourceUrl: fetched.url, doi, method:"http", ...(version ? { version } : {}) };
        await validate?.(retrieved);
        return retrieved;
      } catch (error) { itemSignal.throwIfAborted(); lastError = error; return null; }
    };
    // Try provider URLs even if DOI resolution or Unpaywall is unavailable.
    let cursor = 0;
    while (cursor < queue.length && cursor < 4) {
      const result = await tryUrl(queue[cursor++]);
      if (result) return result;
    }
    if (!doi) {
      progress("DOI 보완 검색");
      try { doi = await this.lookupDoi(work, itemSignal); } catch (error) { itemSignal.throwIfAborted(); lastError = error; }
    }
    if (doi) {
      progress("공개 원문 위치 검색");
      try {
        const data = await this.json(`https://api.unpaywall.org/v2/${encodeURI(doi)}?email=${encodeURIComponent(email)}`, itemSignal);
        queue.push(...unpaywallUrls(data));
        landings.push(...urls([data?.best_oa_location?.url_for_landing_page]), `https://doi.org/${encodeURI(doi)}`);
      } catch (error) { itemSignal.throwIfAborted(); lastError = error; landings.push(`https://doi.org/${encodeURI(doi)}`); }
    }
    while (cursor < queue.length && tried.size < 8) {
      const result = await tryUrl(queue[cursor++]);
      if (result) return result;
    }
    for (const landing of urls(landings).slice(0, 4)) {
      queue.push(...publisherPdfUrls(landing));
      const direct = await tryUrl(landing);
      if (direct) return direct;
      while (cursor < queue.length && tried.size < 12) {
        const result = await tryUrl(queue[cursor++]);
        if (result) return result;
      }
    }
    throw lastError instanceof AppError ? lastError : new AppError("FULLTEXT_UNAVAILABLE", "자동으로 PDF를 확보하지 못했습니다. 원문 페이지에서 로그인하거나 PDF를 직접 연결하세요.");
  }
  /**
   * The last resort after every other route: each mirror's page for the DOI, then
   * the PDF it embeds. Requests look like a browser's and keep the mirror's cookies.
   * A robot check is never answered here; it is reported with the page so the
   * person can pass it in Chrome. A missing article (HTTP 404) is final.
   */
  async sciHub(work: Work, mirrors: string[], path: string, signal: AbortSignal, progress: (message: string) => void,
    validate?: (retrieved: RetrievedPdf) => Promise<void>): Promise<RetrievedPdf> {
    const stageSignal = AbortSignal.any([signal, AbortSignal.timeout(this.limits.sciHubMs)]);
    let doi = cleanDoi(work.doi);
    if (!doi) {
      progress("Sci-Hub · DOI 보완 검색");
      doi = await this.lookupDoi(work, stageSignal).catch(() => { signal.throwIfAborted(); return null; });
    }
    if (!doi) throw new SciHubError("SCIHUB_NO_DOI", "DOI를 확인할 수 없어 Sci-Hub 미러에서 찾지 못했습니다.");
    const failures: SciHubError[] = [];
    for (const mirror of mirrors) {
      const page = sciHubUrl(mirror, doi), host = new URL(page).hostname, where = `Sci-Hub 미러(${host})`;
      const failed = (error: unknown) => {
        signal.throwIfAborted();
        if (error instanceof SciHubError) return error;
        if (error instanceof AppError && ["WRONG_PDF", "AUXILIARY_PDF", "INVALID_PDF", "DOWNLOAD_SIZE"].includes(error.code)) return new SciHubError(error.code, error.message);
        if ((error as NodeJS.ErrnoException)?.code === "ENOTFOUND") return new SciHubError("SCIHUB_UNAVAILABLE", `${where} 주소를 찾을 수 없습니다.`);
        // A slow or dropped connection may still open in Chrome.
        return new SciHubError("SCIHUB_UNAVAILABLE", `${where}에서 PDF를 받지 못했습니다.`, page);
      };
      const found = (sourceUrl: string): RetrievedPdf => ({ sourceUrl, doi, method: "http", mirror: host });
      progress(`Sci-Hub 미러 확인 · ${host}`);
      let pdfs: string[];
      try {
        const opened = await this.fetchCandidate(page, path, stageSignal, { headers: sciHubHeaders(), cookies: this.sciHubCookies, acceptStatus: true });
        // The mirror may answer with the PDF itself; usually its page embeds the storage URL.
        if (opened.kind === "pdf") { const retrieved = found(opened.url); await validate?.(retrieved); return retrieved; }
        const refusal = sciHubRefusal(opened, host, page);
        if (refusal) throw refusal;
        pdfs = sciHubPdfUrls(opened.html, opened.url).slice(0, 3);
        if (!pdfs.length) throw sciHubMissing(opened.html)
          ? new SciHubError("SCIHUB_MISSING", `${where}에 이 논문의 PDF가 없습니다.`)
          : new SciHubError("SCIHUB_NO_LINK", `${where} 페이지에서 PDF 링크를 찾지 못했습니다. Chrome에서 직접 확인할 수 있습니다.`, page);
      } catch (error) { failures.push(failed(error)); continue; }
      for (const candidate of pdfs) {
        try {
          progress(`Sci-Hub PDF 다운로드 · ${new URL(candidate).hostname}`);
          const fetched = await this.fetchCandidate(candidate, path, stageSignal,
            { requestMs: this.limits.sciHubPdfMs, headers: sciHubHeaders(page), cookies: this.sciHubCookies, acceptStatus: true });
          if (fetched.kind === "html") throw sciHubRefusal(fetched, host, page) ??
            new SciHubError("SCIHUB_NOT_PDF", `${where}가 PDF 대신 안내 페이지를 보냈습니다. Chrome에서 직접 확인할 수 있습니다.`, page);
          const retrieved = found(fetched.url);
          await validate?.(retrieved);
          return retrieved;
        } catch (error) {
          const failure = failed(error);
          failures.push(failure);
          if (SCIHUB_GUARDED.has(failure.code)) break;
        }
      }
    }
    // Report the failure a person can act on (a robot check first); a missing article is the last resort.
    const best = failures.reduce<SciHubError | undefined>((top, f) => !top || sciHubRank(f) > sciHubRank(top) ? f : top, undefined);
    throw best || new SciHubError("SCIHUB_MIRROR", "Sci-Hub 미러가 설정되지 않았습니다.");
  }
}
