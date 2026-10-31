import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../../src/service/service";
import { deleteTrashedWorks } from "../../src/service/db/trash";
import { blankWork } from "../../src/shared/domain";
import { DEFAULT_FILTERS } from "../../src/shared/types";
import { schemas } from "../../src/shared/contracts";

async function fixture(fn: (service: Service) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-collections-"));
  const service = new Service(root, "unused", () => {});
  try { await fn(service); }
  finally { service.db.close(); await rm(root, { recursive: true, force: true }); }
}
const members = (service: Service, collectionId: string) =>
  (service.db.db.prepare("SELECT work_id FROM collection_works WHERE collection_id=? ORDER BY work_id").all(collectionId) as { work_id: string }[]).map(r => r.work_id);

test("taking papers out of a collection leaves the archive and other collections, and undo puts them back", () => fixture(async service => {
  const db = service.db, projectId = db.projects()[0].id;
  const [a, b, c, loose] = ["Plasticity A", "Plasticity B", "Psychedelics C", "Loose"].map(title => db.upsert(blankWork({ title })).work.id);
  const topic = db.createCollection(projectId, "Topic"), other = db.createCollection(projectId, "Other");
  assert.deepEqual(await service.call("collectionMembers", schemas.collectionMembers.parse({ projectId, collectionId: topic.id, ids: [a, b, c] })), { ids: [a, b, c] });
  assert.deepEqual(await service.call("collectionMembers", schemas.collectionMembers.parse({ projectId, collectionId: topic.id, ids: [a] })), { ids: [] });
  await service.call("collectionMembers", { projectId, collectionId: other.id, ids: [c] });

  // A paper that is not in the collection, or named twice, is not counted.
  const removed = await service.call("collectionMembers", schemas.collectionMembers.parse({ projectId, collectionId: topic.id, ids: [c, loose, c, b], remove: true }));
  assert.deepEqual(removed, { ids: [c, b] });
  assert.deepEqual(members(service, topic.id), [a]);
  assert.deepEqual(members(service, other.id), [c]);
  assert.equal(db.state(projectId, c).screening, "included");
  assert.equal(db.counts(projectId).archive, 3);
  assert.equal(db.collections(projectId).find(x => x.id === topic.id)?.count, 1);

  assert.equal(db.undo(projectId), true);
  assert.deepEqual(members(service, topic.id), [a, b, c].sort());
  assert.deepEqual(members(service, other.id), [c]);
  // A removal that takes nothing out records nothing, so undo reaches the earlier save and leaves the collection alone.
  assert.deepEqual(await service.call("collectionMembers", { projectId, collectionId: topic.id, ids: [loose], remove: true }), { ids: [] });
  assert.equal(db.undo(projectId), true);
  assert.deepEqual(members(service, topic.id), [a, b, c].sort());

  const elsewhere = db.createProject("Elsewhere", "").id;
  await assert.rejects(service.call("collectionMembers", { projectId: elsewhere, collectionId: topic.id, ids: [a], remove: true }), /대상 컬렉션/);
  assert.deepEqual(members(service, topic.id), [a, b, c].sort());
}));

test("a filtered-out list shows what the filters leave out, with every id and each reason's count", () => fixture(async service => {
  const db = service.db, projectId = db.projects()[0].id;
  const works = [
    { title: "Synaptic plasticity after psilocybin", year: 2022 },
    { title: "Cortical plasticity in development", year: 2010 },
    { title: "Ketamine and mood", year: 2023 },
    { title: "Serotonin receptors", year: 2005 },
  ].map(w => db.upsert(blankWork(w)).work.id);
  const trashed = db.upsert(blankWork({ title: "Trashed plasticity paper", year: 2021 })).work.id;
  const collection = db.createCollection(projectId, "Psychedelics");
  await service.call("collectionMembers", { projectId, collectionId: collection.id, ids: [...works, trashed] });
  db.mutate(projectId, [trashed], { screening: "trash" });
  const filters = { ...DEFAULT_FILTERS, include: "plasticity", yearFrom: 2015 };
  const list = (extra = {}) => db.list(schemas.list.parse({ projectId, scope: "collection", scopeId: collection.id, filters: { ...filters, ...extra }, limit: 1 }));

  const kept = list();
  assert.deepEqual(kept.ids, [works[0]]);
  assert.equal(kept.hidden, 3);
  // Every page: the ids reach past the one-paper page.
  assert.deepEqual([...kept.hiddenIds].sort(), [works[1], works[2], works[3]].sort());
  assert.deepEqual([...kept.hiddenBy].sort((x, y) => x.reason.localeCompare(y.reason)), [
    { reason: "출판 기간 밖", count: 2 },
    { reason: "포함어 없음: plasticity", count: 2 },
  ]);

  const out = list({ filteredOut: true });
  assert.equal(out.total, 3);
  assert.equal(out.works.length, 1);
  assert.deepEqual([...out.ids].sort(), [...kept.hiddenIds].sort());
  assert.deepEqual(out.hiddenIds, kept.hiddenIds);
  assert.ok(out.works.every(w => w.evidence?.hidden.length));
  // Trashed members belong to no list but the trash, on either side of the filters.
  assert.ok(![...kept.ids, ...out.ids].includes(trashed));

  // 필터 결과만 남기기: the collection keeps the filter's result.
  await service.call("collectionMembers", { projectId, collectionId: collection.id, ids: kept.hiddenIds, remove: true });
  assert.deepEqual(db.list(schemas.list.parse({ projectId, scope: "collection", scopeId: collection.id, filters: DEFAULT_FILTERS })).ids, [works[0]]);
  assert.equal(list({ filteredOut: true }).total, 0);
  assert.equal(db.counts(projectId).archive, 4);
}));

test("permanent deletion keeps a collection undo from bringing a deleted paper back", () => fixture(async service => {
  const db = service.db, projectId = db.projects()[0].id;
  const [gone, stays] = ["Gone", "Stays"].map(title => db.upsert(blankWork({ title })).work.id);
  const collection = db.createCollection(projectId, "Topic");
  await service.call("collectionMembers", { projectId, collectionId: collection.id, ids: [gone, stays] });
  await service.call("collectionMembers", { projectId, collectionId: collection.id, ids: [gone, stays], remove: true });
  db.trash(projectId, [gone]);
  deleteTrashedWorks(db, projectId, [gone]);
  // Deletion drops the deleted paper from every undo entry, so the removal comes back for the paper still here only.
  assert.equal(db.undo(projectId), true);
  assert.deepEqual(members(service, collection.id), [stays]);
}));
