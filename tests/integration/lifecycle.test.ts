import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLog, redact } from "../../src/platform/log";
import { ServiceHost } from "../../src/platform/service-host";
import type { AppEvent } from "../../src/shared/types";

const host = (root: string, events: AppEvent[], delays?: number[]) =>
  new ServiceHost(resolve("dist/runtime/service.js"), resolve("dist/runtime/pdf-worker.cjs"), (event) => events.push(event), root, delays);
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const until = async (done: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end && !done(); ) await Bun.sleep(25);
  return done();
};
/** Marks the library as written by a newer app, so the service refuses to open it. */
function makeNewer(library: string) {
  const db = new Database(join(library, "library.sqlite"));
  db.exec("PRAGMA user_version=99");
  db.close();
}

test("the log keeps key-like values out and rolls over once", async () => {
  expect(redact("Authorization: Bearer abcdefgh12345678 key sk-abcdefghijklmnop")).not.toMatch(/abcdefgh12345678|abcdefghijklmnop/);
  expect(redact('{"api_key":"0123456789abcdef"}')).not.toContain("0123456789abcdef");
  const address = ["reader", "example.org"].join("@");
  expect(redact(`sent as ${address}`)).not.toContain(address);
  expect(redact("OpenAlex 요청 실패 (503)")).toBe("OpenAlex 요청 실패 (503)");
  const root = await mkdtemp(join(tmpdir(), "researchbunny-log-"));
  try {
    const log = createLog(root, "test");
    log("error", "first", new Error("boom"));
    const path = join(root, "logs", "researchbunny.log");
    const text = await readFile(path, "utf8");
    expect(text).toMatch(/ERROR \[test\] first\n {4}Error: boom/);
    await writeFile(path, "x".repeat(1024 * 1024 + 1));
    log("info", "after rollover");
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await lstat(path + ".1")).size).toBeGreaterThan(1024 * 1024);
    // No data folder, no log, no error.
    createLog(undefined, "test")("error", "nowhere");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a library the service cannot open is reported with its reason and not retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-fatal-"));
  const events: AppEvent[] = [];
  const service = host(root, events, [50, 50, 50]);
  try {
    await mkdir(join(root, "library"), { recursive: true });
    makeNewer(join(root, "library"));
    await expect(service.start(join(root, "library"), {})).rejects.toMatchObject({ code: "NEWER_SCHEMA" });
    await Bun.sleep(400);
    expect(service.pid).toBeUndefined();
    expect(events).toEqual([]);
    expect(await readFile(join(root, "logs", "researchbunny.log"), "utf8")).toContain("The library could not be opened");
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("a service that dies is restarted, and one that cannot come back says why and stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-restart-"));
  const events: AppEvent[] = [];
  const service = host(root, events, [50, 50, 50]);
  try {
    await service.start(join(root, "library"), {});
    const first = service.pid!;
    process.kill(first, "SIGKILL");
    expect(await until(() => !!service.pid && service.pid !== first && events.filter((e) => e.type === "changed").length >= 2)).toBe(true);
    await service.call("snapshot");

    makeNewer(join(root, "library"));
    const second = service.pid!;
    events.length = 0;
    process.kill(second, "SIGKILL");
    expect(await until(() => events.some((e) => e.type === "service-error" && !!e.message?.includes("더 새로운 앱")))).toBe(true);
    await Bun.sleep(400);
    expect(service.pid).toBeUndefined();
    await expect(service.call("snapshot")).rejects.toMatchObject({ code: "SERVICE_DOWN" });
    expect(await readFile(join(root, "logs", "researchbunny.log"), "utf8")).toContain("The service exited");
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("with no restarts left the app says so once instead of looping", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-giveup-"));
  const events: AppEvent[] = [];
  const service = host(root, events, []);
  try {
    await service.start(join(root, "library"), {});
    process.kill(service.pid!, "SIGKILL");
    expect(await until(() => events.some((e) => e.type === "service-error" && !!e.message?.includes("다시 시작하지 못했습니다")))).toBe(true);
    await Bun.sleep(300);
    expect(service.pid).toBeUndefined();
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("stopping waits for the service to close its library and leave", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-stop-"));
  const service = host(root, []);
  try {
    await service.start(join(root, "library"), {});
    const pid = service.pid!;
    await service.stop();
    expect(alive(pid)).toBe(false);
    // Closed cleanly: nothing is left in the write-ahead log.
    const wal = await lstat(join(root, "library", "library.sqlite-wal")).catch(() => null);
    expect(wal?.size ?? 0).toBe(0);
    expect(await readFile(join(root, "logs", "researchbunny.log"), "utf8").catch(() => "")).not.toContain("killed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("a lock link left by the old app for a pid now used by something else does not block launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-oldlock-"));
  const other = Bun.spawn(["/bin/sleep", "30"]);
  try {
    await symlink(`${hostname()}-${other.pid}`, join(root, "SingletonLock"));
    const source = `import {acquireInstance} from ${JSON.stringify(resolve("src/platform/instance.ts"))}; console.log(await acquireInstance(process.argv[1],()=>{})); process.exit(0);`;
    const launch = Bun.spawn([process.execPath, "-e", source, root], { stdout: "pipe", stderr: "pipe" });
    expect((await new Response(launch.stdout).text()).trim()).toBe("true");
    expect(await lstat(join(root, "SingletonLock")).catch(() => null)).toBeNull();
  } finally {
    other.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
