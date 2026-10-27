import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { AppError, type AppEvent } from "../../shared/types";
import { CdpConnection, chromeClosed, type CdpEvent } from "./cdp";

export type BrowserDownload = { guid: string; url: string; suggestedFilename: string; state: "inProgress" | "completed" | "canceled"; path: string };
/** The run's work tab: a minimized window of the app's own Chrome. */
export interface BrowserTab {
  /** Downloads that begin from now on are saved into `directory` and listed by `downloads()`. */
  collect(directory: string, signal: AbortSignal): Promise<void>;
  downloads(): BrowserDownload[];
  navigate(url: string, signal: AbortSignal): Promise<void>;
  evaluate<T>(expression: string, signal: AbortSignal): Promise<T>;
  /** Shows the window for what only the person can do there, such as a robot check. */
  reveal(message: string, signal: AbortSignal): Promise<void>;
  /** Cancels unfinished downloads and blanks the page for the next paper. */
  reset(): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserHost {
  tab(signal: AbortSignal): Promise<BrowserTab>;
  /** Back to Chrome's own download handling once no run collects downloads. */
  idle(): Promise<void>;
}

const CHROME_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")];
// Without these, pages report navigator.webdriver and minimized windows run timers ~10x slower;
// both trip robot checks (measured 2026-10-27 on Chrome 156).
const FLAGS = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--no-startup-window",
  "--disable-blink-features=AutomationControlled", "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
// PDFs download instead of opening the viewer, without a save dialog or the multiple-downloads prompt.
const PREFS = {
  plugins: { always_open_pdf_externally: true },
  download: { prompt_for_download: false },
  profile: { default_content_setting_values: { automatic_downloads: 1 }, exit_type: "Normal", exited_cleanly: true },
};
// A popup window takes focus even when closed at once, so the work tab opens everything in place.
const NO_POPUPS = `window.open = function (url) { if (url) location.href = new URL(String(url), location.href).href; return null; };`;
const LOGIN_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>ResearchBunny 전용 Chrome</title>
<body style="font:15px/1.6 -apple-system,sans-serif;max-width:34em;margin:4em auto;padding:0 1em;color:#222">
<h1 style="font-size:20px">ResearchBunny 전용 Chrome</h1>
<p>논문 원문을 받을 때 쓰는 앱 전용 Chrome입니다. 평소 쓰시는 Chrome과 프로필·로그인이 섞이지 않습니다.</p>
<p>이 창의 주소창에서 소속 기관 도서관·학외 접속(프록시)과 자주 쓰는 출판사에 한 번 로그인해 두세요. 로그인은 이 전용 프로필에 저장되고, 앱을 다시 열어도 이어집니다.</p>
<p>다 됐으면 이 창을 닫으면 됩니다.</p></body>`)}`;
const SESSION_MAGIC = Buffer.from("RBC1");
const SESSION_MAX_AGE = 7 * 24 * 3600_000;
const COOKIE_FIELDS = ["name", "value", "path", "secure", "httpOnly", "sameSite", "priority", "sourceScheme", "sourcePort", "partitionKey"] as const;

function merge(target: Record<string, any>, source: Record<string, any>) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) merge(target[key] = target[key] && typeof target[key] === "object" ? target[key] : {}, value);
    else target[key] = value;
  }
  return target;
}

/** One Chrome instance with a profile of its own, owned by the service; the person's Chrome is never driven. */
export class ChromeHost implements BrowserHost {
  readonly profile: string;
  private sessionFile: string;
  private child: ChildProcess | null = null;
  private cdp: CdpConnection | null = null;
  private starting: Promise<CdpConnection> | null = null;
  private saver?: ReturnType<typeof setInterval>;
  private login: string | null = null;
  private work: CdpTab | null = null;
  constructor(private options: {
    dataRoot: string;
    /** Chrome's executable, or a stand-in for tests. */
    command?: string[];
    /** Base64 AES-256 key held in the Keychain; without it session cookies are not kept across restarts. */
    cookieKey?: () => string | undefined;
    emit?: (event: AppEvent) => void;
    timeoutMs?: number;
  }) {
    this.profile = join(options.dataRoot, "chrome-profile");
    this.sessionFile = join(options.dataRoot, "chrome-session.bin");
  }
  get pid() { return this.child?.pid; }
  /** The person has opened the login window at least once. */
  ready() { return existsSync(join(this.profile, ".researchbunny-ready")); }

  private command() {
    if (this.options.command) return this.options.command;
    const path = CHROME_PATHS.find(candidate => existsSync(candidate));
    if (!path) throw new AppError("CHROME_MISSING", "Google Chrome이 설치되어 있지 않습니다. Chrome을 설치하면 로그인이 필요한 원문도 받을 수 있습니다.");
    return [path];
  }
  private async enforcePrefs() {
    const path = join(this.profile, "Default", "Preferences");
    await mkdir(join(this.profile, "Default"), { recursive: true, mode: 0o700 });
    // Chrome rewrites the file while running and the person may change settings in the login window.
    const prefs = await readFile(path, "utf8").then(text => JSON.parse(text) as Record<string, any>).catch(() => ({}));
    await writeFile(path, JSON.stringify(merge(prefs, PREFS)), { mode: 0o600 });
  }
  /** Ends an earlier app Chrome that still holds this profile, e.g. after the service restarted. */
  private async endStale() {
    let owner: string;
    try { owner = await readlink(join(this.profile, "SingletonLock")); }
    catch { return false; }
    const pid = Number(owner.split("-").at(-1));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    const command = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout || "";
    // Only ever our own profile's Chrome, never the person's browser.
    if (!command.includes(`--user-data-dir=${this.profile}`)) return false;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && alive(); i++) await delay(100);
    if (alive()) process.kill(pid, "SIGKILL");
    return true;
  }
  private async launch(): Promise<CdpConnection> {
    for (let attempt = 0; ; attempt++) {
      const [file, ...prefix] = this.command();
      await mkdir(this.profile, { recursive: true, mode: 0o700 });
      await this.enforcePrefs();
      const child = spawn(file, [...prefix, `--user-data-dir=${this.profile}`, ...FLAGS], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
      child.stderr!.resume();
      const cdp = new CdpConnection(child.stdio[3] as Writable, child.stdio[4] as Readable, this.options.timeoutMs);
      child.once("exit", () => cdp.close());
      child.once("error", () => cdp.close());
      try {
        await cdp.send("Browser.getVersion", {}, undefined, AbortSignal.timeout(15_000));
      } catch (error) {
        child.kill("SIGKILL");
        // Chrome hands a second launch on a held profile to the running one and exits.
        if (attempt === 0 && cdp.closed && await this.endStale()) continue;
        throw new AppError("CHROME_LAUNCH", "앱 전용 Chrome을 시작하지 못했습니다. Chrome이 최신인지 확인하고 다시 시도하세요.", error instanceof AppError && error.retryable);
      }
      this.child = child;
      cdp.on(event => this.event(event));
      void cdp.done.then(() => {
        if (this.cdp !== cdp) return;
        this.cdp = null; this.child = null; this.work = null; this.login = null;
        clearInterval(this.saver);
      });
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      await this.restoreCookies(cdp).catch(() => {});
      // Covers an app Chrome the person quits from the Dock, which saves nothing on its way out.
      this.saver = setInterval(() => { void this.saveCookies().catch(() => {}); }, 5 * 60_000);
      this.saver.unref();
      return cdp;
    }
  }
  private connect() {
    if (this.cdp && !this.cdp.closed) return Promise.resolve(this.cdp);
    return this.starting ??= this.launch().then(cdp => (this.cdp = cdp)).finally(() => { this.starting = null; });
  }
  private event(event: CdpEvent) {
    if (event.method === "Target.targetDestroyed" && event.params.targetId === this.login) {
      this.login = null;
      void this.saveCookies().catch(() => {});
    }
    this.work?.event(event);
  }

  async tab(signal: AbortSignal): Promise<BrowserTab> {
    if (this.work && this.cdp && !this.cdp.closed) return this.work;
    const cdp = await this.connect();
    signal.throwIfAborted();
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true, windowState: "minimized", focus: false }, undefined, signal);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined, signal);
    // Runtime.enable is never sent: Cloudflare detects it.
    await cdp.send("Page.enable", {}, sessionId, signal);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: NO_POPUPS }, sessionId, signal);
    return this.work = new CdpTab(cdp, targetId, sessionId, message => this.options.emit?.({ type: "attention", message, ...(this.pid ? { pid: this.pid } : {}) }), () => { this.work = null; });
  }
  async idle() {
    if (!this.cdp || this.cdp.closed) return;
    await this.cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
    await this.saveCookies().catch(() => {});
  }
  /** Opens a normal window for logging in; the caller brings Chrome forward from the active app. */
  async openLogin() {
    const cdp = await this.connect();
    const { targetId } = await cdp.send("Target.createTarget", { url: LOGIN_PAGE, newWindow: true });
    this.login = targetId;
    await writeFile(join(this.profile, ".researchbunny-ready"), new Date().toISOString(), { mode: 0o600 });
    return { pid: this.pid };
  }
  /** On app quit: keep the session's logins, then end Chrome. */
  async close() {
    clearInterval(this.saver);
    await this.starting?.catch(() => {});
    const cdp = this.cdp, child = this.child;
    if (!cdp || !child) return;
    await this.saveCookies().catch(() => {});
    const exited = new Promise(resolve => child.once("exit", resolve));
    await cdp.send("Browser.close", {}, undefined, AbortSignal.timeout(1000)).catch(() => {});
    await Promise.race([exited, delay(1500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    cdp.close();
  }

  private key() {
    const value = this.options.cookieKey?.();
    const key = value ? Buffer.from(value, "base64") : null;
    return key?.length === 32 ? key : null;
  }
  /** Session cookies (institution SSO, proxies) die with Chrome; they are kept encrypted under the Keychain key. */
  async saveCookies() {
    const key = this.key(), cdp = this.cdp;
    if (!key || !cdp || cdp.closed) return;
    const { cookies } = await cdp.send<{ cookies: any[] }>("Storage.getCookies", {}, undefined, AbortSignal.timeout(2000));
    const session = cookies.filter(cookie => cookie.session).map(cookie => {
      const kept: Record<string, unknown> = {};
      for (const field of COOKIE_FIELDS) if (cookie[field] !== undefined) kept[field] = cookie[field];
      // A host-only cookie must be set by URL; a leading dot marks a domain cookie.
      return String(cookie.domain).startsWith(".") ? { ...kept, domain: cookie.domain } : { ...kept, url: `${cookie.secure ? "https" : "http"}://${cookie.domain}${cookie.path || "/"}` };
    });
    if (!session.length) { await rm(this.sessionFile, { force: true }); return; }
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ savedAt: Date.now(), cookies: session }), "utf8"), cipher.final()]);
    await writeFile(this.sessionFile + ".staging", Buffer.concat([SESSION_MAGIC, iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    await rename(this.sessionFile + ".staging", this.sessionFile);
  }
  private async restoreCookies(cdp: CdpConnection) {
    const key = this.key();
    if (!key) return;
    let file: Buffer;
    try { file = await readFile(this.sessionFile); } catch { return; }
    try {
      if (!file.subarray(0, 4).equals(SESSION_MAGIC)) throw new Error("format");
      const decipher = createDecipheriv("aes-256-gcm", key, file.subarray(4, 16));
      decipher.setAuthTag(file.subarray(16, 32));
      const { savedAt, cookies } = JSON.parse(Buffer.concat([decipher.update(file.subarray(32)), decipher.final()]).toString("utf8"));
      if (Date.now() - savedAt > SESSION_MAX_AGE || !Array.isArray(cookies)) throw new Error("expired");
      await cdp.send("Storage.setCookies", { cookies });
    } catch (error) {
      if (error instanceof AppError) throw error;
      // A file from another key, or too old to matter: drop it rather than keep secrets around.
      await rm(this.sessionFile, { force: true });
    }
  }
}

class CdpTab implements BrowserTab {
  private collecting = false;
  private found = new Map<string, BrowserDownload>();
  private directory = "";
  private revealed = false;
  private popups = new Set<string>();
  constructor(private cdp: CdpConnection, private targetId: string, private sessionId: string,
    private attention: (message: string) => void, private closed: () => void) {}
  event(event: CdpEvent) {
    if (event.method === "Target.targetDestroyed" && event.params.targetId === this.targetId) { this.closed(); return; }
    if (event.method === "Browser.downloadWillBegin" && this.collecting)
      this.found.set(event.params.guid, { guid: event.params.guid, url: event.params.url, suggestedFilename: event.params.suggestedFilename, state: "inProgress", path: join(this.directory, event.params.guid) });
    if (event.method === "Browser.downloadProgress") {
      const download = this.found.get(event.params.guid);
      if (download) download.state = event.params.state;
    }
    // A link with target=_blank opens a tab; its address is loaded here instead.
    if ((event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") && event.params.targetInfo?.type === "page") {
      const info = event.params.targetInfo;
      if (info.openerId === this.targetId) this.popups.add(info.targetId);
      if (this.popups.has(info.targetId) && /^https?:/.test(info.url)) {
        this.popups.delete(info.targetId);
        void this.cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
        void this.cdp.send("Page.navigate", { url: info.url }, this.sessionId).catch(() => {});
        if (!this.revealed) void this.window("minimized").catch(() => {});
      }
    }
  }
  private async window(windowState: "minimized" | "normal") {
    const { windowId } = await this.cdp.send("Browser.getWindowForTarget", { targetId: this.targetId });
    await this.cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState } });
  }
  async collect(directory: string, signal: AbortSignal) {
    await mkdir(directory, { recursive: true });
    await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: directory, eventsEnabled: true }, undefined, signal);
    this.directory = directory; this.found.clear(); this.collecting = true;
  }
  downloads() { return [...this.found.values()]; }
  async navigate(url: string, signal: AbortSignal) {
    // A URL that downloads ends the navigation with ERR_ABORTED; the download events tell the rest.
    await this.cdp.send("Page.navigate", { url }, this.sessionId, signal);
  }
  async evaluate<T>(expression: string, signal: AbortSignal): Promise<T> {
    const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId, signal);
    if (exceptionDetails) throw new AppError("CHROME_SCRIPT", "앱 전용 Chrome에서 페이지를 확인하지 못했습니다.", true);
    return result?.value as T;
  }
  async reveal(message: string, signal: AbortSignal) {
    if (this.cdp.closed) throw chromeClosed();
    this.revealed = true;
    await this.window("normal");
    await this.cdp.send("Page.bringToFront", {}, this.sessionId, signal).catch(() => {});
    this.attention(message);
  }
  async reset() {
    this.collecting = false;
    for (const download of this.found.values())
      if (download.state === "inProgress") await this.cdp.send("Browser.cancelDownload", { guid: download.guid }).catch(() => {});
    await this.cdp.send("Page.navigate", { url: "about:blank" }, this.sessionId, AbortSignal.timeout(3000)).catch(() => {});
    this.revealed = false;
  }
  async close() {
    this.collecting = false;
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }, undefined, AbortSignal.timeout(3000)).catch(() => {});
    this.closed();
  }
}
