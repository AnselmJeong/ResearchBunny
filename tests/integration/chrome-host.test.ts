import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChromeHost } from "../../src/service/fulltext/chrome-host";
import { Service } from "../../src/service/service";
import { AppError, type AppEvent } from "../../src/shared/types";

const fixture = resolve("tests/fixtures/chrome/cdp-pipe.ts");
async function setup(key?: string) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-chrome-host-"));
  const log = join(root, "chrome.jsonl");
  const events: AppEvent[] = [];
  const host = (scenario = "chrome") => new ChromeHost({ dataRoot: root, command: [process.execPath, fixture, scenario, log], cookieKey: () => key, emit: event => events.push(event), timeoutMs: 5000 });
  const entries = async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const requests = async () => (await entries()).filter(entry => entry.method);
  return { root, log, events, host, entries, requests };
}
const cdpOf = (host: ChromeHost) => (host as unknown as { cdp: { send: (method: string, params?: object) => Promise<any> } }).cdp;
const settle = () => Bun.sleep(50);

test("the app's Chrome launches on its own profile with quiet flags, keeps existing prefs, and opens a minimized popup-proof tab", async () => {
  const { root, host, entries, requests } = await setup();
  const chrome = host();
  try {
    await mkdir(join(root, "chrome-profile", "Default"), { recursive: true });
    await writeFile(join(root, "chrome-profile", "Default", "Preferences"), JSON.stringify({ download: { default_directory: "/kept" }, homepage: "kept" }));
    const tab = await chrome.tab(AbortSignal.timeout(5000));
    const argv: string[] = (await entries())[0].argv;
    assert(argv.includes(`--user-data-dir=${join(root, "chrome-profile")}`));
    for (const flag of ["--remote-debugging-pipe", "--no-startup-window", "--disable-blink-features=AutomationControlled", "--disable-backgrounding-occluded-windows"]) assert(argv.includes(flag), flag);
    assert(!argv.some(arg => /enable-automation|headless/.test(arg)));
    const prefs = JSON.parse(await readFile(join(root, "chrome-profile", "Default", "Preferences"), "utf8"));
    assert.equal(prefs.plugins.always_open_pdf_externally, true);
    assert.equal(prefs.download.prompt_for_download, false);
    assert.equal(prefs.download.default_directory, "/kept");
    assert.equal(prefs.homepage, "kept");
    assert.equal(prefs.profile.default_content_setting_values.automatic_downloads, 1);
    const sent = await requests();
    assert.deepEqual(sent.find(r => r.method === "Target.createTarget").params, { url: "about:blank", newWindow: true, windowState: "minimized", focus: false });
    assert(sent.some(r => r.method === "Page.addScriptToEvaluateOnNewDocument" && r.params.source.includes("window.open")));
    assert(!sent.some(r => r.method === "Runtime.enable"), "Runtime.enable is detectable by robot checks");
    assert.equal(await chrome.tab(AbortSignal.timeout(5000)), tab, "one tab serves the run");
  } finally { await chrome.close(); await rm(root, { recursive: true, force: true }); }
});

test("downloads are collected only while a paper is active, popups load in the work tab, and reveal asks for attention", async () => {
  const { root, host, events, requests } = await setup();
  const chrome = host();
  try {
    const tab = await chrome.tab(AbortSignal.timeout(5000));
    const cdp = cdpOf(chrome);
    const begin = (guid: string) => cdp.send("Test.emit", { method: "Browser.downloadWillBegin", params: { frameId: "f", guid, url: `https://pub.example/${guid}.pdf`, suggestedFilename: `${guid}.pdf` } });
    await begin("before");
    await tab.collect(join(root, "item-1"), AbortSignal.timeout(5000));
    await begin("during");
    await cdp.send("Test.emit", { method: "Browser.downloadProgress", params: { guid: "during", state: "completed", totalBytes: 1, receivedBytes: 1 } });
    await settle();
    assert.deepEqual(tab.downloads(), [{ guid: "during", url: "https://pub.example/during.pdf", suggestedFilename: "during.pdf", state: "completed", path: join(root, "item-1", "during") }]);
    assert.deepEqual((await requests()).find(r => r.method === "Browser.setDownloadBehavior").params, { behavior: "allowAndName", downloadPath: join(root, "item-1"), eventsEnabled: true });

    // A target=_blank link: the new tab is closed and its address loaded in the work tab, which stays minimized.
    await cdp.send("Test.emit", { method: "Target.targetCreated", params: { targetInfo: { targetId: "popup", type: "page", url: "", openerId: "target-1" } } });
    await cdp.send("Test.emit", { method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "popup", type: "page", url: "https://pub.example/article.pdf", openerId: "target-1" } } });
    await settle();
    let sent = await requests();
    assert(sent.some(r => r.method === "Target.closeTarget" && r.params.targetId === "popup"));
    assert(sent.some(r => r.method === "Page.navigate" && r.params.url === "https://pub.example/article.pdf" && r.sessionId === "session-target-1"));
    assert(sent.some(r => r.method === "Browser.setWindowBounds" && r.params.bounds.windowState === "minimized"));

    await tab.reveal("로봇 확인을 완료하세요", AbortSignal.timeout(5000));
    sent = await requests();
    assert(sent.some(r => r.method === "Browser.setWindowBounds" && r.params.bounds.windowState === "normal"));
    assert.deepEqual(events.at(-1), { type: "attention", message: "로봇 확인을 완료하세요", pid: chrome.pid });

    await cdp.send("Test.emit", { method: "Browser.downloadWillBegin", params: { frameId: "f", guid: "late", url: "https://x/late.pdf", suggestedFilename: "late.pdf" } });
    await settle();
    await tab.reset();
    await begin("after");
    await settle();
    sent = await requests();
    assert(sent.some(r => r.method === "Browser.cancelDownload" && r.params.guid === "late"), "unfinished downloads are cancelled");
    assert(sent.some(r => r.method === "Page.navigate" && r.params.url === "about:blank"));
    assert(!tab.downloads().some(d => d.guid === "after" || d.guid === "before"));
    await chrome.idle();
    assert.equal((await requests()).filter(r => r.method === "Browser.setDownloadBehavior").at(-1).params.behavior, "default");
  } finally { await chrome.close(); await rm(root, { recursive: true, force: true }); }
});

test("session cookies survive a restart encrypted under the Keychain key, and a foreign key drops the file", async () => {
  const key = randomBytes(32).toString("base64");
  const { root, host, requests } = await setup(key);
  let chrome = host();
  try {
    await chrome.tab(AbortSignal.timeout(5000));
    await cdpOf(chrome).send("Storage.setCookies", { cookies: [
      { name: "_shibsession", value: "sso-secret", domain: "idp.example.edu", path: "/", secure: true, httpOnly: true, session: true },
      { name: "ezproxy", value: "proxy-secret", domain: ".lib.example.edu", path: "/", secure: true, session: true },
      { name: "remember", value: "persistent", domain: "pub.example", path: "/", secure: true, session: false, expires: 2e9 },
    ] });
    await chrome.close();
    const file = await readFile(join(root, "chrome-session.bin"));
    assert(!file.includes("sso-secret") && !file.includes("proxy-secret"), "cookies are not stored in plain text");

    chrome = host();
    await chrome.tab(AbortSignal.timeout(5000));
    const restored = (await requests()).filter(r => r.method === "Storage.setCookies").at(-1).params.cookies;
    assert.deepEqual(restored, [
      { name: "_shibsession", value: "sso-secret", path: "/", secure: true, httpOnly: true, url: "https://idp.example.edu/" },
      { name: "ezproxy", value: "proxy-secret", path: "/", secure: true, domain: ".lib.example.edu" },
    ]);
    await chrome.close();
  } finally { await chrome.close(); }

  // Another key (e.g. a reset Keychain) cannot read the file; it is removed rather than kept around.
  const before = (await requests()).length;
  chrome = new ChromeHost({ dataRoot: root, command: [process.execPath, fixture, "chrome", join(root, "chrome.jsonl")], cookieKey: () => randomBytes(32).toString("base64"), timeoutMs: 5000 });
  try {
    await chrome.tab(AbortSignal.timeout(5000));
    assert(!(await requests()).slice(before).some(r => r.method === "Storage.setCookies"));
    await assert.rejects(readFile(join(root, "chrome-session.bin")), "an unreadable file is removed");
  } finally { await chrome.close(); await rm(root, { recursive: true, force: true }); }
});

test("an earlier app Chrome holding the profile is ended and replaced, but another process's lock is never touched", async () => {
  const { root, host, entries } = await setup();
  const profile = join(root, "chrome-profile");
  await mkdir(profile, { recursive: true });
  // A leftover app Chrome from before a service restart.
  const stale = spawn(process.execPath, [fixture, "chrome", join(root, "stale.jsonl"), `--user-data-dir=${profile}`], { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });
  for (let i = 0; i < 100; i++) { if (await readFile(join(root, "stale.jsonl"), "utf8").catch(() => "")) break; await Bun.sleep(20); }
  await Bun.sleep(100);
  const chrome = host();
  try {
    await chrome.tab(AbortSignal.timeout(10000));
    await new Promise(resolve => stale.exitCode !== null || stale.signalCode !== null ? resolve(null) : stale.once("exit", resolve));
    assert.notEqual(stale.exitCode ?? stale.signalCode, null);
    assert((await entries()).some(entry => entry.handoff), "the first launch was handed to the stale instance");
  } finally { await chrome.close(); stale.kill("SIGKILL"); }

  // A lock pointing at a process that is not the app's Chrome: launching fails, the process lives.
  const other = spawn("/bin/sleep", ["30"]);
  await rm(join(profile, "SingletonLock"), { force: true });
  await symlink(`${hostname()}-${other.pid}`, join(profile, "SingletonLock"));
  try {
    await assert.rejects(host().tab(AbortSignal.timeout(10000)), (error: unknown) => error instanceof AppError && error.code === "CHROME_LAUNCH");
    assert.equal(other.exitCode, null);
    assert.doesNotThrow(() => process.kill(other.pid!, 0));
  } finally { other.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
});

test("the login window opens normal and focused, marks the profile ready, and saves logins when it closes", async () => {
  const key = randomBytes(32).toString("base64");
  const { root, host, requests } = await setup(key);
  const chrome = host();
  try {
    assert.equal(chrome.ready(), false);
    const { pid } = await chrome.openLogin();
    assert.equal(pid, chrome.pid);
    assert.equal(chrome.ready(), true);
    const created = (await requests()).find(r => r.method === "Target.createTarget").params;
    assert.equal(created.newWindow, true);
    assert.equal(created.windowState, undefined, "a window the person uses is not minimized");
    assert(created.url.startsWith("data:text/html") && decodeURIComponent(created.url).includes("ResearchBunny 전용 Chrome"));
    await cdpOf(chrome).send("Storage.setCookies", { cookies: [{ name: "sso", value: "secret", domain: "idp.example.edu", path: "/", secure: true, session: true }] });
    await cdpOf(chrome).send("Target.closeTarget", { targetId: "target-1" });
    for (let i = 0; i < 100 && !(await readFile(join(root, "chrome-session.bin")).catch(() => null)); i++) await settle();
    assert((await readFile(join(root, "chrome-session.bin"))).length > 32, "closing the login window saves the session");
  } finally { await chrome.close(); await rm(root, { recursive: true, force: true }); }
});

test("the service reports the app Chrome's readiness and opens the login window even while a run is busy", async () => {
  const { root, log } = await setup();
  const service = new Service(join(root, "library"), resolve("dist/runtime/pdf-worker.cjs"), () => {});
  service.chrome = new ChromeHost({ dataRoot: root, command: [process.execPath, fixture, "chrome", log], timeoutMs: 5000 });
  const projectId = service.db.projects()[0].id;
  try {
    assert.deepEqual((await service.call("missingPdfs", { projectId, scope: "archive" })).chrome, { ready: false });
    service.downloads.active.set("busy-run", new AbortController());
    assert.equal(typeof (await service.call("openChromeLogin", {})).pid, "number");
    service.downloads.active.delete("busy-run");
    assert.deepEqual((await service.call("missingPdfs", { projectId, scope: "archive" })).chrome, { ready: true });
    // App quit saves and ends the app's Chrome.
    await service.call("shutdown", {});
    assert.equal(service.chrome.pid, undefined);
  } finally { await service.chrome.close(); service.downloads.stopRecoveryMonitor(); service.db.close(); await rm(root, { recursive: true, force: true }); }
});
