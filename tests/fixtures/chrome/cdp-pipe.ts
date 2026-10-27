// A deterministic stand-in for Chrome on --remote-debugging-pipe: NUL-delimited JSON on fds 3 (in) and 4 (out).
// argv: scenario, log file, then the Chrome arguments the host passed.
import { appendFileSync, createReadStream, createWriteStream, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const [scenario, logFile, ...chromeArgs] = process.argv.slice(2);
const profile = chromeArgs.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
appendFileSync(logFile, JSON.stringify({ argv: chromeArgs }) + "\n");
const lock = profile && join(profile, "SingletonLock");
// Chrome's lock is a dangling symlink to "host-pid", so it is read with readlink, not stat.
const owner = () => {
  try { return readlinkSync(lock!); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
};
// Like Chrome: a running instance owns the profile, and a second launch hands over and exits.
if (lock) {
  if (owner()) { appendFileSync(logFile, JSON.stringify({ handoff: owner() }) + "\n"); process.exit(0); }
  symlinkSync(`${hostname()}-${process.pid}`, lock);
}
const release = () => { if (lock && owner().endsWith(`-${process.pid}`)) unlinkSync(lock); };
process.on("exit", release);
process.on("SIGTERM", () => process.exit(0));
if (scenario === "exit") process.exit(0);

const output = createWriteStream("", { fd: 4 });
const send = (message: unknown) => output.write(JSON.stringify(message) + "\0");
const cookies: any[] = [];
const windows = new Map<string, string>();
let targets = 0;
let buffer = Buffer.alloc(0);
createReadStream("", { fd: 3 }).on("data", (chunk: Buffer | string) => {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
  let end: number;
  while ((end = buffer.indexOf(0)) >= 0) {
    const request = JSON.parse(buffer.subarray(0, end).toString());
    buffer = buffer.subarray(end + 1);
    appendFileSync(logFile, JSON.stringify({ method: request.method, params: request.params, sessionId: request.sessionId }) + "\n");
    if (scenario === "silent") continue;
    const reply = (result: unknown) => send({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
    const p = request.params ?? {};
    switch (request.method) {
      case "Browser.getVersion": reply({ product: "FakeChrome/1.0" }); break;
      case "Browser.close": reply({}); setTimeout(() => process.exit(0), 10); break;
      case "Target.createTarget": {
        const targetId = `target-${++targets}`;
        windows.set(targetId, p.windowState ?? "normal");
        reply({ targetId });
        send({ method: "Target.targetCreated", params: { targetInfo: { targetId, type: "page", url: p.url ?? "" } } });
        break;
      }
      case "Target.attachToTarget": reply({ sessionId: `session-${p.targetId}` }); break;
      case "Target.closeTarget":
        windows.delete(p.targetId);
        reply({ success: true });
        send({ method: "Target.targetDestroyed", params: { targetId: p.targetId } });
        break;
      case "Browser.getWindowForTarget": reply({ windowId: 1, bounds: { windowState: windows.get(p.targetId) ?? "normal" } }); break;
      case "Storage.getCookies": reply({ cookies }); break;
      case "Storage.setCookies": cookies.push(...p.cookies); reply({}); break;
      case "Runtime.evaluate": reply({ result: { type: "string", value: `evaluated:${p.expression}` } }); break;
      // Lets a test make the fake browser raise any event.
      case "Test.emit": reply({}); send({ method: p.method, params: p.params, ...(p.sessionId ? { sessionId: p.sessionId } : {}) }); break;
      case "Test.fail": send({ id: request.id, error: { code: -32000, message: "fixture failure" } }); break;
      default: reply({});
    }
  }
}).on("close", () => process.exit(0));
