import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError, type Work } from "../../shared/types";
import { cleanDoi, publicUrl, publisherPdfUrls, type RetrievedPdf } from "./engine";
import type { BrowserHost, BrowserTab } from "./chrome-host";

const probeSchema = z.object({
  url: z.string(), ready: z.string(), challenge: z.boolean(), login: z.boolean(), links: z.array(z.string()),
  state: z.string().optional(), contentType: z.string().optional(),
});
export type ChromeProbe = z.infer<typeof probeSchema>;
const PROBE_JS = `(() => {
  const links = [];
  const add = value => { try { const u = new URL(value, location.href); if (/^https?:$/.test(u.protocol) && !u.username && !u.password && !links.includes(u.href)) links.push(u.href); } catch {} };
  for (const m of document.querySelectorAll('meta[name="citation_pdf_url"]')) add(m.content);
  for (const a of document.querySelectorAll('a[href]')) {
    if (/\\.pdf(?:[?#]|$)|\\/(?:pdf|pdfdirect|epdf|pdfft|article-pdf)(?:[/?]|$)/i.test(a.getAttribute('href') || '') || /^(?:view|download|get) (?:full[- ]text )?pdf|^pdf$/i.test((a.textContent || '').trim())) add(a.href);
  }
  for (const el of document.querySelectorAll('link[type="application/pdf"][href], [data-pdf-url], [data-article-pdf-url]')) add(el.getAttribute('href') || el.getAttribute('data-pdf-url') || el.getAttribute('data-article-pdf-url'));
  for (const el of document.querySelectorAll('object[data], embed[src], iframe[src]')) { const src = el.getAttribute('data') || el.getAttribute('src') || ''; if (el.type === 'application/pdf' || /\\.pdf(?:[?#]|$)/i.test(src)) add(src); }
  // Sci-Hub's robot check is an ALTCHA form; its article page has one too, but alongside the PDF.
  const challenge = /just a moment|verify you are human|checking your browser|security check|사람인지 확인|로봇 확인|^ddos-guard$/i.test(document.title) || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-running') || (!links.length && !!document.querySelector('altcha-widget'));
  // An institution or publisher sign-in page: a visible password field on a login-looking address or title.
  const password = [...document.querySelectorAll('input[type="password"]')].some(el => el.offsetParent !== null);
  const login = !challenge && !links.length && password && (/shibboleth|openathens|ezproxy|saml|wayf|\\/idp\\/|\\/cas\\/|log-?in|sign-?in|auth/i.test(location.href) || /log ?in|sign ?in|로그인|institution|기관/i.test(document.title));
  if (!challenge && !login && !links.length && !window.__researchbunnyMenu && document.readyState === 'complete') {
    const menu = [...document.querySelectorAll('button, [role="button"], summary, a[aria-haspopup]')].find(el => /^(download|download pdf|pdf|다운로드)$/i.test((el.textContent || '').trim()));
    if (menu) { window.__researchbunnyMenu = true; menu.click(); }
  }
  return JSON.stringify({url:location.href, ready:document.readyState, challenge, login, links:links.slice(0, 10), state:window.__researchbunnyDownload?.state, contentType:document.contentType});
})()`;
export function browserFetchScript(url: string, filename: string) {
  return `(() => {
    window.__researchbunnyDownload?.controller?.abort();
    const controller = new AbortController();
    const state = {state:'running', controller};
    window.__researchbunnyDownload = state;
    const timer = setTimeout(() => controller.abort(), 15000);
    (async () => {
      const r = await fetch(${JSON.stringify(url)}, {credentials:'include', signal:controller.signal});
      if (!r.ok || !r.body || Number(r.headers.get('content-length')) > 157286400) throw Error('response');
      const reader = r.body.getReader(), parts = []; let size = 0;
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 157286400) throw Error('size'); parts.push(chunk.value); } }
      finally { await reader.cancel().catch(() => {}); }
      const blob = new Blob(parts, {type:'application/pdf'});
      const header = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
      if (!String.fromCharCode(...header).includes('%PDF-')) { state.state = 'notpdf'; return; }
      const a = document.createElement('a'), objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl; a.download = ${JSON.stringify(filename)};
      (document.body || document.documentElement).appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000); state.state = 'done';
    })().catch(() => { state.state = 'error'; }).finally(() => clearTimeout(timer));
    return 'started';
  })()`;
}
export interface BrowserRetrieval {
  retrieve(work: Work, path: string, signal: AbortSignal, progress: (message: string) => void,
    validate: (candidate: RetrievedPdf) => Promise<void>, options: RetrievalOptions): Promise<RetrievedPdf>;
  /** Ends the run's browser session. */
  release?(): Promise<void>;
}
export type RetrievalOptions = {
  /** Where this paper's browser downloads are saved. */
  downloads: string;
  /** Downloads that turned out to be another paper go here as `.pdf`, for the run's other papers. */
  rejected?: string;
  /** Opens another page than the paper's own, e.g. a Sci-Hub mirror's page for its DOI. */
  start?: string;
  /** False for unattended runs: the window is never shown and nobody is waited for. */
  interactive?: boolean;
};
type Timing = { budgetMs: number; pollMs: number; autoMs: number; challengeMs: number; loginMs: number };
const TIMING: Timing = { budgetMs: 60_000, pollMs: 1000, autoMs: 5000, challengeMs: 30_000, loginMs: 90_000 };
/** Retrieval in the app's own Chrome: one minimized tab for the run, downloads saved straight into staging. */
export class ChromeDownloads implements BrowserRetrieval {
  private tab: BrowserTab | null = null;
  private timing: Timing;
  constructor(private host: BrowserHost, timing: Partial<Timing> = {}) { this.timing = { ...TIMING, ...timing }; }
  async release() {
    const tab = this.tab;
    this.tab = null;
    await tab?.close();
    await this.host.idle();
  }
  async retrieve(work: Work, path: string, signal: AbortSignal, progress: (message: string) => void,
    validate: (candidate: RetrievedPdf) => Promise<void>, { downloads, rejected, start, interactive = true }: RetrievalOptions) {
    const { budgetMs, pollMs, autoMs, challengeMs, loginMs } = this.timing;
    const doi = cleanDoi(work.doi);
    const initial = start ? publicUrl(start) : publicUrl(work.url) || (doi ? `https://doi.org/${encodeURI(doi)}` : publicUrl(work.oaUrl));
    if (!initial) throw new AppError('CHROME_NO_URL', 'Chrome에서 열 원문 주소가 없습니다.');
    // Waiting for the person extends the deadline; the hard stop bounds even that.
    const itemSignal = AbortSignal.any([signal, AbortSignal.timeout(budgetMs + loginMs)]);
    let deadline = Date.now() + budgetMs;
    progress(start ? `앱 전용 Chrome에서 열기 · ${new URL(initial).hostname}` : '앱 전용 Chrome에서 원문 열기');
    const tab = this.tab = await this.host.tab(itemSignal);
    const filename = `researchbunny-${randomUUID()}.pdf`;
    const tried = new Set<string>(), handled = new Set<string>();
    let lastUrl = '', stableSince = Date.now(), pending: string | null = null;
    let exhaustedSince = 0, waitingSince = 0, fetchedSince = 0, asked = false, probeErrors = 0;
    try {
      await tab.collect(downloads, itemSignal);
      await tab.navigate(initial, itemSignal);
      while (true) {
        itemSignal.throwIfAborted();
        if (Date.now() > deadline) throw new AppError('CHROME_TIMEOUT', '앱 전용 Chrome에서 시간 안에 PDF를 받지 못했습니다. 재시도하거나 원문 페이지에서 직접 받으세요.', true);
        for (const download of tab.downloads()) {
          if (download.state !== 'completed' || handled.has(download.guid)) continue;
          handled.add(download.guid);
          const ours = download.suggestedFilename === filename;
          const candidate: RetrievedPdf = {sourceUrl:publicUrl(download.url) || pending || publicUrl(lastUrl) || initial, doi, method:"chrome", requireIdentity:!ours};
          await copyFile(download.path, path);
          try { await validate(candidate); return candidate; }
          catch (error) {
            itemSignal.throwIfAborted();
            if (rejected) await mkdir(rejected, {recursive:true}).then(() => rename(download.path, join(rejected, `${download.guid}.pdf`))).catch(() => {});
            if (ours) throw error;
          }
        }
        if (tab.downloads().some(download => download.state === 'inProgress')) {
          progress('앱 전용 Chrome에서 PDF 내려받는 중');
          await delay(pollMs, undefined, {signal:itemSignal});
          continue;
        }
        let info: ChromeProbe;
        try { info = probeSchema.parse(JSON.parse(await tab.evaluate<string>(PROBE_JS, itemSignal))); probeErrors = 0; }
        catch (error) {
          itemSignal.throwIfAborted();
          // A page mid-navigation has no context to evaluate in; only a page that never answers fails.
          if (!(error instanceof AppError) || error.code === 'CHROME_CLOSED' || ++probeErrors > 5) throw error;
          await delay(pollMs, undefined, {signal:itemSignal});
          continue;
        }
        const current = publicUrl(info.url);
        if (!current) throw new AppError('CHROME_URL', 'Chrome의 원문 주소를 확인할 수 없습니다.');
        if (current !== lastUrl) { lastUrl = current; stableSince = Date.now(); exhaustedSince = 0; }
        if (info.challenge || info.login) {
          waitingSince ||= Date.now();
          const waited = Date.now() - waitingSince, wait = info.login ? loginMs : challengeMs;
          // Many robot checks clear by themselves within seconds; the window stays down for those.
          if (!interactive && waited > autoMs)
            throw info.login ? new AppError('CHROME_LOGIN', '로그인이 필요한 페이지입니다. PDF 원문 찾기의 "전용 Chrome 열기(로그인)"에서 로그인한 뒤 재시도하세요.')
              : new AppError('CHROME_CHALLENGE', '사람 인증(로봇 확인)이 필요한 페이지라 넘어갔습니다. PDF 원문 찾기에서 재시도하면 확인 창을 띄웁니다.');
          if (interactive && !asked && waited > (info.login ? 0 : autoMs)) {
            asked = true;
            const message = info.login ? '앱 전용 Chrome에서 기관·출판사 로그인을 완료하세요' : '앱 전용 Chrome에서 사람 인증을 완료하세요';
            progress(`${message} · ${Math.round(wait / 1000)}초 후 다음 문헌으로 이동`);
            deadline = Math.max(deadline, Date.now() + wait + 15_000);
            await tab.reveal(message, itemSignal);
          }
          if (asked && waited > wait + (info.login ? 0 : autoMs))
            throw new AppError(info.login ? 'CHROME_LOGIN' : 'CHROME_CHALLENGE', info.login ? '로그인 대기 시간이 지나 다음 문헌으로 넘어갑니다. 로그인 후 재시도하세요.' : '사람 인증 대기 시간이 지나 다음 문헌으로 넘어갑니다.');
        } else if (info.ready !== 'loading' && Date.now() - stableSince >= Math.min(3000, pollMs * 3)) {
          waitingSince = 0;
          if (pending) {
            if (info.state === 'done') {
              // The page handed the PDF to Chrome; its download events finish the job.
              fetchedSince ||= Date.now();
              if (Date.now() - fetchedSince > 20_000) throw new AppError('CHROME_DOWNLOAD', '앱 전용 Chrome에서 파일 저장을 완료하지 못했습니다.');
            } else if (info.state !== 'running') {
              const url = pending; pending = null; fetchedSince = 0;
              if (info.state === 'error' && current !== url) { await tab.navigate(url, itemSignal); stableSince = Date.now(); }
            }
          } else {
            const candidates = [...info.links.flatMap(url => /wiley\.com\/doi\/e?pdf\//.test(url) ? [url.replace(/\/doi\/e?pdf\//, '/doi/pdfdirect/'), url] : [url]), ...publisherPdfUrls(current)];
            if (info.contentType === 'application/pdf' || /\.pdf(?:[?#]|$)/i.test(current)) candidates.unshift(current);
            const next = candidates.map(url => publicUrl(url)).find((url): url is string => !!url && !tried.has(url));
            if (next && tried.size < 8) {
              tried.add(next); exhaustedSince = 0;
              progress(`Chrome PDF 다운로드 · ${new URL(next).hostname}`);
              if (new URL(next).origin === new URL(current).origin && !/(?:^|\.)(?:sciencedirect|elsevier)\.com$/.test(new URL(next).hostname)) {
                pending = next; await tab.evaluate(browserFetchScript(next, filename), itemSignal);
              } else { await tab.navigate(next, itemSignal); stableSince = Date.now(); }
            } else {
              if (!exhaustedSince) { exhaustedSince = Date.now(); progress('Chrome에서 PDF 링크를 찾지 못했습니다 · 5초 후 다음 문헌으로 이동'); }
              if (Date.now() - exhaustedSince > 5000) throw new AppError('CHROME_UNAVAILABLE', '앱 전용 Chrome에서도 PDF를 확보하지 못했습니다. 원문 페이지에서 직접 내려받거나 재시도하세요.');
            }
          }
        }
        await delay(pollMs, undefined, {signal:itemSignal});
      }
    } catch (error) { itemSignal.throwIfAborted(); throw error; }
    finally { await tab.reset().catch(() => {}); }
  }
}
