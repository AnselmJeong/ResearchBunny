import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { deleteTrashedWorks } from "../../src/service/db/trash";
import { undoMerge } from "../../src/service/db/merge";
import { Service } from "../../src/service/service";
import { blankWork } from "../../src/shared/domain";
import {
  DEFAULT_FILTERS,
  type Run,
  type Evidence,
} from "../../src/shared/types";
import { schemas } from "../../src/shared/contracts";
import { defaultView, restoreNavigation } from "../../src/shared/navigation";

async function fixture(
  fn: (db: Library, root: string) => Promise<void> | void,
) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-trash-"));
  const db = new Library(root);
  try {
    await fn(db, root);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}
function run(projectId: string, id: string, inputIds: string[]): Run {
  return {
    id,
    projectId,
    mode: "related",
    query: "",
    inputIds,
    seedProfileId: null,
    filters: DEFAULT_FILTERS,
    status: "completed",
    createdAt: id,
    updatedAt: id,
    calls: 0,
    maxCalls: 1,
    maxCandidates: 100,
    total: null,
    count: 1,
    message: "",
    tasks: inputIds.map((seedId) => ({
      kind: "cites",
      seedId,
      origin: "test",
    })),
    rankingVersion: "test",
  };
}
const evidence: Evidence = {
  origins: [],
  seedIds: [],
  sharedIds: [],
  denominator: 1,
  relation: "test",
  score: 0,
  reasons: [],
  hidden: [],
  deferred: false,
  scope: "test",
};

test("permanent deletion removes project entries and old history references while preserving shared works and PDFs", () =>
  fixture(async (db, root) => {
    const p = db.projects()[0].id,
      other = db.createProject("Other", "").id;
    const a = db.upsert(
      blankWork({ title: "Delete unique", doi: "10.9999/delete" }),
    ).work;
    const b = db.upsert(blankWork({ title: "Shared record" })).work;
    const c = db.upsert(blankWork({ title: "Keep active" })).work;
    db.mutate(p, [a.id, b.id, c.id], {
      screening: "included",
      note: "local note",
    });
    db.mutate(other, [b.id], { screening: "included", note: "other note" });
    const collection = db.createCollection(p, "Current");
    const otherCollection = db.createCollection(other, "Other");
    db.db
      .prepare("INSERT INTO collection_works VALUES(?,?)")
      .run(collection.id, a.id);
    db.db
      .prepare("INSERT INTO collection_works VALUES(?,?)")
      .run(otherCollection.id, b.id);
    db.setSeeds(p, [a.id, b.id, c.id], "", { group: [a.id, c.id] });
    db.setSeeds(other, [b.id], "", {});
    for (let n = 0; n < 105; n++) {
      const r = run(p, String(n).padStart(3, "0"), [a.id, c.id]);
      db.saveRun(r);
      db.candidate(r, a, evidence);
    }
    const externalRun = run(other, "other", [b.id]);
    db.saveRun(externalRun);
    db.candidate(externalRun, b, evidence);
    const remainingRun = run(p, "remaining", [a.id, c.id]);
    db.saveRun(remainingRun);
    db.candidate(remainingRun, c, { ...evidence, seedIds: [a.id, c.id] });
    const importing = run(p, "import", [a.id]);
    importing.import = {
      workId: a.id,
      paths: ["original.pdf"],
      index: 0,
      mode: "linked",
    };
    db.saveRun(importing);
    db.db
      .prepare("INSERT INTO import_items VALUES(?,?,?,?,?,?)")
      .run("item", importing.id, "original.pdf", "completed", "ok", a.id);
    for (const mode of ["managed", "linked"] as const) {
      const path = join(root, `${mode}.pdf`);
      await writeFile(path, "original bytes");
      db.saveAttachment({
        id: mode,
        workId: a.id,
        mode,
        path,
        name: "original.pdf",
        hash: mode,
        size: 14,
        exists: true,
        status: "ready",
      });
    }
    db.pref(
      "ui:" + p,
      defaultView({
        scope: "trash",
        selected: [a.id, b.id, c.id],
        inspectorId: a.id,
      }),
    );
    db.mutate(p, [a.id, b.id], { screening: "trash" });
    db.db
      .prepare("INSERT INTO merge_history VALUES(1,?,?)")
      .run("{}", db.pref<number>("revision")!);
    assert.deepEqual(deleteTrashedWorks(db, p, [a.id, b.id, a.id]).ids, [
      a.id,
      b.id,
    ]);
    assert.equal(db.counts(p).trash, 0);
    assert.throws(() => db.get(a.id));
    assert.equal(db.findIdentifier("doi", "10.9999/delete"), undefined);
    assert.equal(db.get(b.id).id, b.id);
    assert.equal(db.state(other, b.id).note, "other note");
    assert.equal(db.collections(other)[0].count, 1);
    assert.equal(db.candidates(externalRun.id).length, 1);
    assert.deepEqual(db.candidates(remainingRun.id)[0].evidence.seedIds, [
      c.id,
    ]);
    assert.deepEqual(db.seedHistory(p)[0].ids, [c.id]);
    assert.deepEqual(db.seedHistory(p)[0].groups.group, [c.id]);
    assert.deepEqual(db.run("000").inputIds, [c.id]);
    assert.equal(db.run("000").count, 0);
    assert.equal(db.run(importing.id).import?.workId, undefined);
    assert.deepEqual(db.run(importing.id).import?.paths, []);
    assert.equal(db.attachments(a.id).length, 0);
    for (const mode of ["managed", "linked"])
      assert.equal(
        await readFile(join(root, `${mode}.pdf`), "utf8"),
        "original bytes",
      );
    const nav = restoreNavigation(db.pref<Record<string, unknown>>("ui:" + p)!);
    assert.deepEqual(nav.views[nav.keys[nav.index]].selected, [c.id]);
    assert.equal(nav.views[nav.keys[nav.index]].inspectorId, null);
    while (db.undo(p)) {
      /* Unrelated changes can still be undone. */
    }
    assert.equal(
      !!db.db
        .prepare("SELECT 1 FROM project_works WHERE project_id=? AND work_id=?")
        .get(p, b.id),
      false,
    );
    assert.equal(undoMerge(db), false);
    assert.equal((db.db.pragma("foreign_key_check") as unknown[]).length, 0);
  }));

test("invalid selection and storage failure roll back the entire deletion", () =>
  fixture((db) => {
    const p = db.projects()[0].id;
    const a = db.upsert(blankWork({ title: "Trashed" })).work;
    const b = db.upsert(blankWork({ title: "Active" })).work;
    db.mutate(p, [a.id], { screening: "trash" });
    db.mutate(p, [b.id], { screening: "included" });
    assert.throws(() => deleteTrashedWorks(db, p, [a.id, b.id]), /휴지통/);
    assert.throws(() => deleteTrashedWorks(db, p, [a.id, "missing"]), /휴지통/);
    assert.equal(db.counts(p).trash, 1);
    db.db.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON works BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    );
    assert.throws(() => deleteTrashedWorks(db, p, [a.id]), /injected failure/);
    assert.equal(db.get(a.id).id, a.id);
    assert.equal(db.counts(p).trash, 1);
    assert.equal((db.db.pragma("foreign_key_check") as unknown[]).length, 0);
  }));

test("empty trash covers all pages but preserves active entries and other projects", () =>
  fixture((db) => {
    const p = db.projects()[0].id,
      other = db.createProject("Other", "").id;
    const ids: string[] = [];
    db.transaction(() => {
      for (let n = 0; n < 510; n++)
        ids.push(db.upsert(blankWork({ title: `Trash ${n}` })).work.id);
      db.mutate(p, ids, { screening: "trash" });
    });
    const active = db.upsert(blankWork({ title: "Active" })).work;
    db.mutate(p, [active.id], { screening: "included" });
    db.mutate(other, [ids[0]], { screening: "trash" });
    assert.equal(deleteTrashedWorks(db, p).ids.length, 510);
    assert.equal(db.counts(p).trash, 0);
    assert.equal(db.counts(other).trash, 1);
    assert.equal(db.get(active.id).id, active.id);
    assert.deepEqual(deleteTrashedWorks(db, p).ids, []);
  }));

test("deletion command validates scope and refuses while jobs run", async () => {
  assert.equal(
    schemas.deleteTrashedWorks.safeParse({
      projectId: "p",
      target: { kind: "selected", ids: [] },
    }).success,
    false,
  );
  assert.equal(
    schemas.deleteTrashedWorks.safeParse({ projectId: "p" }).success,
    false,
  );
  const root = await mkdtemp(join(tmpdir(), "researchbunny-trash-service-"));
  const service = new Service(root, "unused", () => {});
  try {
    const projectId = service.db.projects()[0].id;
    const work = service.db.upsert(blankWork({ title: "Busy" })).work;
    service.db.mutate(projectId, [work.id], { screening: "trash" });
    service.discovery.active.set("job", new AbortController());
    await assert.rejects(
      service.call("deleteTrashedWorks", {
        projectId,
        target: { kind: "all" },
      }),
      /작업이 끝난/,
    );
    assert.equal(service.db.counts(projectId).trash, 1);
    service.discovery.active.clear();
    assert.deepEqual(
      await service.call("deleteTrashedWorks", {
        projectId,
        target: { kind: "all" },
      }),
      { ids: [work.id] },
    );
  } finally {
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
