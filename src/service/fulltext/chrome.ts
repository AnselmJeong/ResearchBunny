import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError, type Work } from "../../shared/types";
import { cleanDoi, publicUrl, publisherPdfUrls, untilAborted, type RetrievedPdf } from "./engine";

export type ChromeTab = { windowId: string; tabId: string };
const probeSchema = z.object({
  url: z.string(), ready: z.string(), challenge: z.boolean(), links: z.array(z.string()),
  state: z.string().optional(), contentType: z.string().optional(),
});
export type ChromeProbe = z.infer<typeof probeSchema>;
export interface ChromeControl {
  open(url: string, signal: AbortSignal): Promise<ChromeTab>;
  probe(tab: ChromeTab, signal: AbortSignal): Promise<ChromeProbe>;
  navigate(tab: ChromeTab, url: string, signal: AbortSignal): Promise<void>;
  download(tab: ChromeTab, url: string, filename: string, signal: AbortSignal): Promise<void>;
  close(tab: ChromeTab): Promise<void>;
}
// Adapted from bib-dl's ChromeAppleScript and _ChromeAutoDownloader. Commands
// target only the tab created by this job; scripts and URLs are argv, never shell text.
const APPLESCRIPT = `on run argv
  set op to item 1 of argv
  tell application "Google Chrome"
    if op is "open" then
      if (count of windows) is 0 then make new window
      set w to front window
      tell w to set t to make new tab with properties {URL:(item 2 of argv)}
      activate
      return ((id of w) as text) & "," & ((id of t) as text)
    end if
    set t to tab id ((item 3 of argv) as integer) of window id ((item 2 of argv) as integer)
    if op is "navigate" then
      set URL of t to item 4 of argv
    else if op is "js" then
      return execute t javascript (item 4 of argv)
    else if op is "info" then
      return (URL of t) & linefeed & (title of t) & linefeed & ((loading of t) as text)
    else if op is "close" then
      close t
    end if
  end tell
  return ""
end run`;
const PROBE_JS = `(() => {
  const challenge = /just a moment|verify you are human|checking your browser|security check|사람인지 확인/i.test(document.title) || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-running');
  const links = [];
  const add = value => { try { const u = new URL(value, location.href); if (/^https?:$/.test(u.protocol) && !u.username && !u.password && !links.includes(u.href)) links.push(u.href); } catch {} };
  for (const m of document.querySelectorAll('meta[name="citation_pdf_url"]')) add(m.content);
  for (const a of document.querySelectorAll('a[href]')) {
    if (/\\.pdf(?:[?#]|$)|\\/(?:pdf|pdfdirect|epdf|pdfft|article-pdf)(?:[/?]|$)/i.test(a.getAttribute('href') || '') || /^(?:view|download|get) (?:full[- ]text )?pdf|^pdf$/i.test((a.textContent || '').trim())) add(a.href);
  }
  for (const el of document.querySelectorAll('link[type="application/pdf"][href], [data-pdf-url], [data-article-pdf-url]')) add(el.getAttribute('href') || el.getAttribute('data-pdf-url') || el.getAttribute('data-article-pdf-url'));
  if (!challenge && !links.length && !window.__researchbunnyMenu && document.readyState === 'complete') {
    const menu = [...document.querySelectorAll('button, [role="button"], summary, a[aria-haspopup]')].find(el => /^(download|download pdf|pdf|다운로드)$/i.test((el.textContent || '').trim()));
    if (menu) { window.__researchbunnyMenu = true; menu.click(); }
  }
  return JSON.stringify({url:location.href, ready:document.readyState, challenge, links:links.slice(0, 10), state:window.__researchbunnyDownload?.state, contentType:document.contentType});
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
function script(args: string[], signal?: AbortSignal, timeout = 10000): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-', ...args], { stdio: ['pipe', 'pipe', 'pipe'], signal, timeout });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value; if (stdout.length > 1_000_000) child.kill(); });
    child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr = (stderr + value).slice(-4096); });
    child.once('error', reject);
    child.once('close', code => {
      if (signal?.aborted) { reject(signal.reason); return; }
      if (code === 0) resolve(stdout.trim());
      else reject(new AppError(/-1743|not authorized|not permitted|허용되지|권한/i.test(stderr) ? 'CHROME_PERMISSION' : /javascript|java script/i.test(stderr) ? 'CHROME_JAVASCRIPT' : 'CHROME_CONTROL',
        /-1743|not authorized|not permitted|허용되지|권한/i.test(stderr)
          ? 'Chrome 제어 권한이 필요합니다. macOS 개인정보 보호 및 보안 → 자동화에서 ResearchBunny의 Chrome 제어를 허용하세요.'
          : /javascript|java script/i.test(stderr)
            ? 'Chrome의 보기 → 개발자 → Apple Events의 JavaScript 허용이 필요합니다. 설정 후 재시도하세요.'
            : 'Chrome 탭을 제어하지 못했습니다. Chrome 창과 다운로드 설정을 확인하세요.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(APPLESCRIPT);
  });
}
export class SystemChrome implements ChromeControl {
  async open(url: string, signal: AbortSignal) {
    const value = await script(['open', url], signal);
    const match = /^(\d+),(\d+)$/.exec(value);
    if (!match) throw new AppError('CHROME_CONTROL', 'Chrome 작업 탭을 만들지 못했습니다.');
    return { windowId: match[1], tabId: match[2] };
  }
  async probe(tab: ChromeTab, signal: AbortSignal) {
    const args = [tab.windowId, tab.tabId];
    const info = (await script(['info', ...args], signal)).split('\n');
    const data = probeSchema.parse(JSON.parse(await script(['js', ...args, PROBE_JS], signal)));
    // Chrome's built-in PDF viewer has an extension origin, but the tab's URL
    // remains the publisher URL and is the source recorded with the attachment.
    data.url = info[0];
    if (info.at(-1) === 'true') data.ready = 'loading';
    return data;
  }
  async navigate(tab: ChromeTab, url: string, signal: AbortSignal) { await script(['navigate', tab.windowId, tab.tabId, url], signal); }
  async download(tab: ChromeTab, url: string, filename: string, signal: AbortSignal) { await script(['js', tab.windowId, tab.tabId, browserFetchScript(url, filename)], signal); }
  async close(tab: ChromeTab) { await script(['close', tab.windowId, tab.tabId], undefined, 3000).catch(() => {}); }
}
export async function chromeDownloadDirectories(home = homedir()) {
  const root = join(home, 'Library/Application Support/Google/Chrome');
  const directories = new Set([join(home, 'Downloads')]);
  try {
    const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'));
    for (const profile of Object.keys(state.profile?.info_cache || {})) {
      if (!/^(Default|Profile \d+)$/.test(profile)) continue;
      try {
        const prefs = JSON.parse(await readFile(join(root, profile, 'Preferences'), 'utf8'));
        if (typeof prefs.download?.default_directory === 'string' && prefs.download.default_directory.startsWith('/')) directories.add(prefs.download.default_directory);
      } catch { /* A profile may have been removed. */ }
    }
  } catch { /* Default Downloads remains usable. */ }
  return [...directories];
}
type FileStamp = { size: number; mtime: number };
export async function downloadedPdfs(directories: string[]) {
  const files = new Map<string, FileStamp>();
  let readable = false;
  for (const directory of directories) {
    const names = await readdir(directory).catch(() => null);
    if (!names) continue;
    readable = true;
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.pdf')) continue;
      const path = join(directory, name), info = await lstat(path).catch(() => null);
      if (info?.isFile() && info.size > 0 && info.size <= 150 * 1024 * 1024) files.set(path, {size:info.size, mtime:info.mtimeMs});
    }
  }
  if (!readable) throw new AppError('CHROME_DIRECTORY', 'Chrome 다운로드 폴더에 접근하지 못했습니다. 원문 찾기의 폴더 선택에서 Chrome의 저장 폴더를 지정하세요.');
  return files;
}
export interface BrowserRetrieval {
  retrieve(work: Work, path: string, signal: AbortSignal, progress: (message: string) => void,
    validate: (candidate: RetrievedPdf) => Promise<void>, directory?: string): Promise<RetrievedPdf>;
}
export class ChromeDownloads implements BrowserRetrieval {
  constructor(private chrome: ChromeControl = new SystemChrome(), private directories = chromeDownloadDirectories,
    private budgetMs = 60000, private pollMs = 1000) {}
  async retrieve(work: Work, path: string, signal: AbortSignal, progress: (message: string) => void,
    validate: (candidate: RetrievedPdf) => Promise<void>, directory?: string) {
    const doi = cleanDoi(work.doi);
    const initial = publicUrl(work.url) || (doi ? `https://doi.org/${encodeURI(doi)}` : publicUrl(work.oaUrl));
    if (!initial) throw new AppError('CHROME_NO_URL', 'Chrome에서 열 원문 주소가 없습니다.');
    const itemSignal = AbortSignal.any([signal, AbortSignal.timeout(this.budgetMs)]);
    progress('Chrome 다운로드 폴더 확인');
    const dirs = directory ? [directory] : await untilAborted(this.directories(), AbortSignal.any([itemSignal, AbortSignal.timeout(2000)]))
      .catch(() => { itemSignal.throwIfAborted(); return [join(homedir(), 'Downloads')]; });
    const baseline = await untilAborted(downloadedPdfs(dirs), itemSignal);
    const filename = `researchbunny-${randomUUID()}.pdf`;
    const tried = new Set<string>(), rejected = new Set<string>();
    let previousFiles = new Map<string, FileStamp>();
    let lastUrl = '', stableSince = Date.now(), pending: string | null = null;
    let exhaustedSince = 0, challengeSince = 0, downloadedSince = 0;
    progress('로그인된 Chrome에서 원문 열기');
    const tab = await this.chrome.open(initial, itemSignal);
    try {
      while (true) {
        itemSignal.throwIfAborted();
        const files = await untilAborted(downloadedPdfs(dirs), itemSignal);
        for (const [file, stamp] of files) {
          const before = baseline.get(file), previous = previousFiles.get(file);
          if ((before?.mtime === stamp.mtime && before.size === stamp.size) || rejected.has(file) || previous?.size !== stamp.size || previous.mtime !== stamp.mtime) continue;
          const candidate: RetrievedPdf = {sourceUrl:pending || publicUrl(lastUrl) || initial, doi, method:"chrome", requireIdentity:!file.endsWith(filename)};
          await copyFile(file, path); // Preserve the user's original download.
          try { await validate(candidate); return candidate; }
          catch (error) { itemSignal.throwIfAborted(); rejected.add(file); if (file.endsWith(filename)) throw error; }
        }
        previousFiles = files;
        const info = await this.chrome.probe(tab, itemSignal);
        const current = publicUrl(info.url);
        if (!current) throw new AppError('CHROME_URL', 'Chrome의 원문 주소를 확인할 수 없습니다.');
        if (current !== lastUrl) { lastUrl = current; stableSince = Date.now(); exhaustedSince = 0; }
        if (info.challenge) {
          if (!challengeSince) { challengeSince = Date.now(); progress('Chrome에서 사람 인증을 완료하세요 · 30초 후 다음 문헌으로 이동'); }
          if (Date.now() - challengeSince > 30000) throw new AppError('CHROME_CHALLENGE', 'Chrome 사람 인증 대기 시간이 초과되어 다음 문헌으로 넘어갑니다.');
        } else if (info.ready !== 'loading' && Date.now() - stableSince >= Math.min(3000, this.pollMs * 3)) {
          challengeSince = 0;
          if (pending) {
            if (info.state === 'done') {
              if (!downloadedSince) { downloadedSince = Date.now(); progress('Chrome 다운로드 완료 대기 · 저장 창이 열렸다면 저장하세요'); }
              if (Date.now() - downloadedSince > 20000) throw new AppError('CHROME_DOWNLOAD', 'Chrome에서 파일 저장을 완료하지 못했습니다. 다운로드 차단 또는 저장 위치를 확인하세요.');
            } else if (info.state !== 'running') {
              const url = pending; pending = null;
              if (info.state === 'error' && current !== url) { await this.chrome.navigate(tab, url, itemSignal); stableSince = Date.now(); }
            }
          } else {
            const candidates = [...info.links.flatMap(url => /wiley\.com\/doi\/e?pdf\//.test(url) ? [url.replace(/\/doi\/e?pdf\//, '/doi/pdfdirect/'), url] : [url]), ...publisherPdfUrls(current)];
            if (info.contentType === 'application/pdf' || /\.pdf(?:[?#]|$)/i.test(current)) candidates.unshift(current);
            const next = candidates.map(url => publicUrl(url)).find((url): url is string => !!url && !tried.has(url));
            if (next && tried.size < 8) {
              tried.add(next); exhaustedSince = 0;
              progress(`Chrome PDF 다운로드 · ${new URL(next).hostname}`);
              if (new URL(next).origin === new URL(current).origin && !/(?:^|\.)(?:sciencedirect|elsevier)\.com$/.test(new URL(next).hostname)) {
                pending = next; await this.chrome.download(tab, next, filename, itemSignal);
              } else { await this.chrome.navigate(tab, next, itemSignal); stableSince = Date.now(); }
            } else {
              if (!exhaustedSince) { exhaustedSince = Date.now(); progress('Chrome에서 PDF를 직접 내려받을 수 있습니다 · 5초 후 다음 문헌으로 이동'); }
              if (Date.now() - exhaustedSince > 5000) throw new AppError('CHROME_UNAVAILABLE', '로그인된 Chrome에서도 PDF를 확보하지 못했습니다. 원문 페이지에서 직접 내려받거나 재시도하세요.');
            }
          }
        }
        await delay(this.pollMs, undefined, {signal:itemSignal});
      }
    } catch (error) { itemSignal.throwIfAborted(); throw error; }
    finally { await this.chrome.close(tab); }
  }
}
