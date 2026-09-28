import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../../src/service/service";
import { OpenAlex } from "../../src/service/providers/openalex";
import { Discovery } from "../../src/service/discovery/engine";
import { blankWork } from "../../src/shared/domain";
import { DEFAULT_FILTERS } from "../../src/shared/types";
import { schemas } from "../../src/shared/contracts";

async function fixture(fn: (service: Service) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-pending-"));
  const service = new Service(root, "unused", () => {});
  try { await fn(service); }
  finally { service.db.close(); await rm(root, { recursive: true, force: true }); }
}

test("clear pending covers all pages, preserves saved states and other projects, persists and undoes", () => fixture(async service => {
  const db = service.db, projectId = db.projects()[0].id;
  const other = db.createProject("Other", "").id;
  const ids = Array.from({ length: 65 }, (_, i) => db.upsert(blankWork({ title: `Candidate ${i}` })).work.id);
  db.mutate(projectId, ids, { screening: "pending", note: "Keep notes", tags: ["keep"] });
  // Existing libraries can lack the newly introduced field.
  db.db.prepare("UPDATE project_works SET state=json_remove(state,'$.pendingDismissed') WHERE project_id=?").run(projectId);
  db.mutate(other, [ids[0]], { screening: "pending" });
  const saved = db.upsert(blankWork({ title: "Saved" })).work.id;
  const excluded = db.upsert(blankWork({ title: "Excluded" })).work.id;
  const trashed = db.upsert(blankWork({ title: "Trashed" })).work.id;
  db.mutate(projectId, [saved], { screening: "included" });
  db.mutate(projectId, [excluded], { screening: "excluded" });
  db.mutate(projectId, [trashed], { screening: "trash" });
  db.setSeeds(projectId, [ids[0]], "Question", {});
  const result = await service.call("clearPending", schemas.clearPending.parse({ projectId }));
  assert.equal(result.ids.length, 65);
  assert.equal(db.counts(projectId).pending, 0);
  assert.equal(db.counts(other).pending, 1);
  assert.equal(db.counts(projectId).archive, 1);
  assert.equal(db.counts(projectId).excluded, 1);
  assert.equal(db.counts(projectId).trash, 1);
  assert.equal(db.list(schemas.list.parse({ projectId, scope: "pending", filters: DEFAULT_FILTERS, showHidden: true })).total, 0);
  assert.equal(db.state(projectId, ids[0]).note, "Keep notes");
  assert.deepEqual(db.state(projectId, ids[0]).tags, ["keep"]);
  assert.deepEqual(db.seedHistory(projectId)[0].ids, [ids[0]]);
  assert.equal(JSON.parse((db.db.prepare("SELECT state FROM project_works WHERE project_id=? AND work_id=?").get(projectId, ids[0]) as { state: string }).state).pendingDismissed, true);
  assert.deepEqual(await service.call("clearPending", { projectId }), { ids: [] });
  assert.equal(db.undo(projectId), true);
  assert.equal(db.counts(projectId).pending, 65);
  service.discovery.active.set("busy", new AbortController());
  await assert.rejects(service.call("clearPending", { projectId }), /진행 중인 작업/);
  service.discovery.active.clear();
  assert.equal(db.counts(projectId).pending, 65);
}));

test("new searches reset pending, rediscover old candidates, preserve history, and extensions keep the inbox", () => fixture(async service => {
  const db = service.db, projectId = db.projects()[0].id;
  const old = db.upsert(blankWork({ title: "Paper 100", openalex: "W100" })).work;
  const stale = db.upsert(blankWork({ title: "Stale" })).work;
  const saved = db.upsert(blankWork({ title: "Paper 200", openalex: "W200" })).work;
  const excluded = db.upsert(blankWork({ title: "Paper 300", openalex: "W300" })).work;
  db.mutate(projectId, [old.id, stale.id], { screening: "pending", note: "Keep" });
  db.mutate(projectId, [saved.id], { screening: "included" });
  db.mutate(projectId, [excluded.id], { screening: "excluded" });
  const fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async () => new Response(JSON.stringify({
    results: [100, 200, 300].map(n => ({ id: `https://openalex.org/W${n}`, title: `Paper ${n}`, referenced_works: [], related_works: [] })),
    meta: { count: 3, next_cursor: null },
  }));
  const discovery = new Discovery(db, new OpenAlex(db, () => undefined, fetcher), () => {});
  const input = schemas.startRun.parse({ projectId, mode: "search", query: "test", ids: [], filters: DEFAULT_FILTERS });
  assert.throws(() => discovery.start({ ...input, query: " " }), /검색어/);
  assert.equal(db.counts(projectId).pending, 2);
  const run = discovery.start(input);
  assert.equal(db.counts(projectId).pending, 0);
  const wait = async () => {
    for (let n = 0; n < 200 && discovery.active.size; n++) await Bun.sleep(10);
    assert.equal(discovery.active.size, 0);
  };
  await wait();
  assert.equal(db.run(run.id).status, "completed");
  assert.equal(db.counts(projectId).pending, 1);
  assert.equal(db.state(projectId, old.id).pendingDismissed, false);
  assert.equal(db.state(projectId, old.id).note, "Keep");
  assert.equal(db.state(projectId, saved.id).screening, "included");
  assert.equal(db.state(projectId, excluded.id).screening, "excluded");
  db.clearPending(projectId);
  assert.equal(db.candidates(run.id).length, 3);
  assert.equal(db.list(schemas.list.parse({ projectId, scope: "run", scopeId: run.id, filters: { ...DEFAULT_FILTERS, hideExcluded: false } })).total, 3);
  db.mutate(projectId, [stale.id], { screening: "pending" });
  const expanded = discovery.start({ ...input, mode: "references", ids: [old.id], parentId: run.id });
  await wait();
  assert.equal(db.run(expanded.id).status, "completed");
  assert.equal(db.counts(projectId).pending, 1);
  discovery.control(run.id, "more");
  await wait();
  assert.equal(db.counts(projectId).pending, 1);
  // Even a failed new search begins a new inbox; previous candidates remain in history.
  const failing = new Discovery(db, new OpenAlex(db, () => undefined, async () => new Response("{}", { status: 401 })), () => {});
  const failed = failing.start({ ...input, query: "failure" });
  assert.equal(db.counts(projectId).pending, 0);
  for (let n = 0; n < 200 && failing.active.size; n++) await Bun.sleep(10);
  assert.equal(db.run(failed.id).status, "failed");
  assert.equal(db.candidates(run.id).length, 3);
  assert.equal(db.undo(projectId), true);
  assert.equal(db.counts(projectId).pending, 1);
}));
