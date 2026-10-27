import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { CdpConnection } from "../../src/service/fulltext/cdp";
import { AppError } from "../../src/shared/types";

const fixture = resolve("tests/fixtures/chrome/cdp-pipe.ts");
async function connect(scenario: string, timeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-cdp-"));
  const log = join(root, "requests.jsonl");
  const child = spawn(process.execPath, [fixture, scenario, log], { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });
  const cdp = new CdpConnection(child.stdio[3] as Writable, child.stdio[4] as Readable, timeoutMs);
  const requests = async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.method);
  return { root, child, cdp, requests };
}

test("CDP over the pipe matches replies to requests, routes session events, and reports protocol errors", async () => {
  const { root, child, cdp, requests } = await connect("chrome");
  try {
    const [version, created] = await Promise.all([cdp.send("Browser.getVersion"), cdp.send("Target.createTarget", { url: "about:blank" })]);
    assert.equal(version.product, "FakeChrome/1.0");
    assert.equal(created.targetId, "target-1");
    // Only the raised event: the fake also announces the target it created, possibly after this subscribes.
    const events: unknown[] = [];
    const stop = cdp.on(event => { if (event.method === "Page.loadEventFired") events.push(event); });
    await cdp.send("Test.emit", { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "session-target-1" });
    await cdp.send("Browser.getVersion");
    assert.deepEqual(events, [{ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "session-target-1" }]);
    stop();
    // Non-ASCII payloads survive the byte framing.
    assert.equal((await cdp.send("Runtime.evaluate", { expression: "'논문'" }, "session-target-1")).result.value, "evaluated:'논문'");
    await assert.rejects(cdp.send("Test.fail"), (error: unknown) => error instanceof AppError && error.code === "CHROME_PROTOCOL");
    const sent = await requests();
    assert.deepEqual(sent.find(r => r.method === "Runtime.evaluate").sessionId, "session-target-1");
  } finally { child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
});

test("CDP requests time out, honour abort signals, and fail once Chrome exits", async () => {
  const silent = await connect("silent", 150);
  try {
    await assert.rejects(silent.cdp.send("Browser.getVersion"), (error: unknown) => error instanceof AppError && error.code === "CHROME_TIMEOUT");
    const control = new AbortController();
    const pending = silent.cdp.send("Browser.getVersion", {}, undefined, control.signal);
    control.abort(new AppError("DOWNLOAD_SKIPPED", "skip"));
    await assert.rejects(pending, (error: unknown) => error instanceof AppError && error.code === "DOWNLOAD_SKIPPED");
  } finally { silent.child.kill("SIGKILL"); await rm(silent.root, { recursive: true, force: true }); }

  const { root, child, cdp } = await connect("chrome");
  try {
    await cdp.send("Browser.close");
    await cdp.done;
    assert.equal(cdp.closed, true);
    await assert.rejects(cdp.send("Browser.getVersion"), (error: unknown) => error instanceof AppError && error.code === "CHROME_CLOSED");
  } finally { child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
});
