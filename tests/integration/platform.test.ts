import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

test("single-instance lock rejects a second writer and recovers after a crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-lock-"));
  const source = `import {acquireInstance} from ${JSON.stringify(resolve("src/platform/instance.ts"))}; const ok=await acquireInstance(process.argv[1],()=>{}); console.log(ok); if(!ok) process.exit(0); setInterval(()=>{},1000);`;
  const launch = () =>
    Bun.spawn([process.execPath, "-e", source, root], {
      stdout: "pipe",
      stderr: "pipe",
    });
  const first = launch();
  let third: ReturnType<typeof launch> | undefined;
  try {
    const reader = first.stdout.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value).trim(),
      "true",
    );
    const second = launch();
    assert.equal((await new Response(second.stdout).text()).trim(), "false");
    assert.equal(await second.exited, 0);
    first.kill("SIGKILL");
    await first.exited;
    third = launch();
    const thirdReader = third.stdout.getReader();
    assert.equal(
      new TextDecoder().decode((await thirdReader.read()).value).trim(),
      "true",
    );
  } finally {
    first.kill();
    if (third) {
      third.kill();
      await third.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("native Keychain helper round-trips a disposable test item", async () => {
  const account = `migration-test-${crypto.randomUUID()}`;
  const helper = resolve("dist/native/researchbunny-platform");
  const request = async (operation: string, value?: string) => {
    const child = Bun.spawn([helper], {
      stdin: new TextEncoder().encode(
        JSON.stringify({ operation, account, value }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    });
    const result: unknown = JSON.parse(await new Response(child.stdout).text());
    assert.equal(await child.exited, 0);
    return result;
  };
  try {
    assert.deepEqual(await request("read"), { value: null });
    await request("write", '{"openalex":"disposable-not-an-api-key"}');
    assert.deepEqual(await request("read"), {
      value: '{"openalex":"disposable-not-an-api-key"}',
    });
    await request("write", "{}");
    assert.deepEqual(await request("read"), { value: "{}" });
  } finally {
    const cleanup = Bun.spawn(
      [
        "/usr/bin/security",
        "delete-generic-password",
        "-s",
        "app.researchbunny.desktop.credentials",
        "-a",
        account,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await cleanup.exited;
  }
}, 15000);
