import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ServiceHost } from "../../src/platform/service-host";
import type { Snapshot, Work, AppEvent } from "../../src/shared/types";

test("Bun service IPC survives process death and reopens the same committed library", async () => {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-runtime-"));
  const events: AppEvent[] = [];
  const host = new ServiceHost(
    resolve("dist/runtime/service.js"),
    resolve("dist/runtime/pdf-worker.cjs"),
    (event) => events.push(event),
  );
  try {
    await host.start(join(root, "library"), {});
    const snapshot = await host.call<Snapshot>("snapshot");
    const projectId = snapshot.projects[0].id;
    const work = await host.call<Work>("manualWork", {
      projectId,
      metadata: { title: "Runtime recovery fixture" },
    });
    await host.call("mutateWorks", {
      projectId,
      ids: [work.id],
      patch: { note: "survives restart", screening: "included" },
    });
    await host.call("init", {
      openalex: "test-only-placeholder",
      secureStorage: true,
    });
    const oldPid = host.pid!;
    process.kill(oldPid, "SIGKILL");
    for (let i = 0; i < 100; i++) {
      if (
        host.pid &&
        host.pid !== oldPid &&
        events.filter((event) => event.type === "changed").length >= 2
      )
        break;
      await Bun.sleep(50);
    }
    const recovered = await host.call<Snapshot>("snapshot");
    assert.equal(recovered.settings.openalexConfigured, true);
    const inspected = await host.call<{ state: { note: string } }>("inspect", {
      projectId,
      workId: work.id,
    });
    assert.equal(inspected.state.note, "survives restart");
    assert(events.some((event) => event.type === "service-error"));
    const exported = await host.call<{ count: number }>("performExport", {
      projectId,
      scope: "selected",
      ids: [work.id],
      path: join(root, "out.bib"),
    });
    assert.equal(exported.count, 1);
    assert.match(
      await readFile(join(root, "out.bib"), "utf8"),
      /Runtime recovery fixture/,
    );
    await assert.rejects(host.call("arbitrary-command"));
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
