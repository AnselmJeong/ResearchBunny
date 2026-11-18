import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library } from "../../src/service/db/database";
import { changesLibrary } from "../../src/shared/contracts";
import { blankWork } from "../../src/shared/domain";
import type { LibraryState } from "../../src/shared/types";

async function fixture<T>(fn: (db: Library) => Promise<T> | T) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-stage5-"));
  const db = new Library(join(root, "library"));
  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("only commands that change something make the window load everything again", () => {
  for (const name of ["passageSearch", "passageAsk", "passageStatus", "importItems", "previewTrashDeletion", "previewBib", "seedQueries", "testConnection", "openExternal", "list", "snapshot"] as const)
    expect(changesLibrary(name, {}, {})).toBe(false);
  for (const name of ["mutateWorks", "importBib", "merge", "saveSettings", "shelfControl", "passageControl", "collectionMembers", "undo"] as const)
    expect(changesLibrary(name, {}, {})).toBe(true);
  // A cancelled dialog chose nothing; a chosen file or folder may have been imported or saved.
  expect(changesLibrary("choosePdf", {}, null)).toBe(false);
  expect(changesLibrary("choosePdf", {}, { runId: "r" })).toBe(true);
  expect(changesLibrary("attachmentAction", { action: "reveal" }, undefined)).toBe(false);
  expect(changesLibrary("attachmentAction", { action: "relink" }, undefined)).toBe(true);
  // Polled every 2.5 s while signing in: a refresh only when the answer differs.
  expect(changesLibrary("codexStatus", {}, { state: "signingIn" })).toBe(true);
  expect(changesLibrary("codexStatus", {}, { state: "signingIn" })).toBe(false);
  expect(changesLibrary("codexStatus", {}, { state: "connected" })).toBe(true);
});

test("sidebar counts match what each paper's state says", () =>
  fixture((db) => {
    const projectId = db.projects()[0].id;
    expect(db.counts(projectId)).toEqual({ archive: 0, pending: 0, starred: 0, reading: 0, trash: 0, excluded: 0 });
    const states: Partial<LibraryState>[] = [
      { screening: "included", starred: true, reading: "reading" },
      { screening: "included", reading: "planned" },
      { screening: "included", reading: "read" },
      { screening: "pending" },
      { screening: "pending", pendingDismissed: true, starred: true },
      { screening: "excluded", reading: "reading" },
      { screening: "trash", starred: true, reading: "reading" },
    ];
    states.forEach((state, n) => {
      const work = db.upsert(blankWork({ title: `Counted paper number ${n}`, source: "manual" })).work;
      db.mutate(projectId, [work.id], state);
    });
    // Trashed papers count nowhere else; a dismissed pending paper is not in the queue but keeps its star.
    expect(db.counts(projectId)).toEqual({ archive: 3, pending: 1, starred: 2, reading: 3, trash: 1, excluded: 1 });
    const other = db.createProject("Other", "");
    expect(db.counts(other.id)).toEqual({ archive: 0, pending: 0, starred: 0, reading: 0, trash: 0, excluded: 0 });
  }));

test("seeing the same record again adds no snapshot; a changed one does", () =>
  fixture((db) => {
    const record = () => blankWork({ source: "openalex", openalex: "W5", doi: "10.5555/again", title: "A paper found by several runs", citations: 10 });
    const first = db.upsert(record()).work;
    const count = () => (db.db.prepare("SELECT count(*) AS n FROM metadata_snapshots WHERE work_id=?").get(first.id) as { n: number }).n;
    for (let i = 0; i < 5; i++) db.upsert({ ...record(), fetchedAt: new Date(Date.now() + i * 1000).toISOString() });
    expect(count()).toBe(1);
    db.upsert({ ...record(), citations: 11 });
    expect(count()).toBe(2);
    db.upsert(blankWork({ source: "bibtex", doi: "10.5555/again", title: "A paper found by several runs" }));
    expect(count()).toBe(3);
    expect(db.get(first.id).citations).toBe(11);
  }));

test("usage totals follow every recorded call", () =>
  fixture((db) => {
    expect(db.usageSummary()).toEqual([]);
    db.usage("codex", "run", 10, 5);
    expect(db.usageSummary()).toEqual([{ provider: "codex", calls: 1, inputTokens: 10, outputTokens: 5 }]);
    db.usage("codex", "run", 1, 1);
    expect(db.usageSummary()[0]).toMatchObject({ calls: 2, inputTokens: 11 });
  }));
