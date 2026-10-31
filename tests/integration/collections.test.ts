import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../../src/service/service";
import { deleteTrashedWorks } from "../../src/service/db/trash";
import { blankWork, filterConditions } from "../../src/shared/domain";
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

test("a filter lists what meets its conditions, 조건 반전 lists what fails them, and 제외 never hides a collection's papers", () => fixture(async service => {
  const db = service.db, projectId = db.projects()[0].id;
  const works = [
    { title: "Synaptic plasticity after psilocybin", year: 2022 },
    { title: "Cortical plasticity in development", year: 2010 },
    { title: "Ketamine and mood", year: 2023 },
    { title: "Serotonin receptors", year: 2005 },
  ].map(w => db.upsert(blankWork(w)).work.id);
  const marked = db.upsert(blankWork({ title: "Plasticity marked excluded in review", year: 2020 })).work.id;
  const trashed = db.upsert(blankWork({ title: "Trashed plasticity paper", year: 2021 })).work.id;
  const collection = db.createCollection(projectId, "Psychedelics");
  await service.call("collectionMembers", { projectId, collectionId: collection.id, ids: [...works, marked, trashed] });
  db.mutate(projectId, [marked], { screening: "excluded" });
  db.mutate(projectId, [trashed], { screening: "trash" });
  const list = (filters: Partial<typeof DEFAULT_FILTERS> = {}) =>
    db.list(schemas.list.parse({ projectId, scope: "collection", scopeId: collection.id, filters: { ...DEFAULT_FILTERS, ...filters }, limit: 1 }));
  const sorted = (ids: string[]) => [...ids].sort();

  // No conditions: every paper in the collection, the one marked 제외 included; only the trash stays out.
  const plain = list();
  assert.deepEqual(sorted(plain.ids), sorted([...works, marked]));
  assert.equal(plain.hidden, 0);
  assert.equal(plain.scoped, 5);

  const conditions = { include: "plasticity", yearFrom: 2015 };
  assert.deepEqual(filterConditions({ ...DEFAULT_FILTERS, ...conditions }), ["2015년부터", "포함어 plasticity"]);
  const kept = list(conditions);
  assert.deepEqual(sorted(kept.ids), sorted([works[0], marked]));
  assert.equal(kept.total, 2);
  assert.equal(kept.works.length, 1);
  assert.equal(kept.scoped, 5);

  // NOT over both conditions: the papers that miss either one, on every page, shown like any list.
  const flipped = list({ ...conditions, negate: true });
  assert.deepEqual(sorted(flipped.ids), sorted([works[1], works[2], works[3]]));
  assert.equal(flipped.total, 3);
  assert.equal(flipped.scoped, 5);
  assert.ok(flipped.works.every(w => !w.evidence?.hidden.length));
  // With no condition to flip, NOT is the plain list.
  assert.deepEqual(sorted(list({ negate: true }).ids), sorted(plain.ids));

  // The reading tab is not a condition: NOT flips the word and keeps the tab.
  db.mutate(projectId, [works[1], works[2]], { reading: "planned" });
  assert.deepEqual(list({ include: "plasticity", reading: "planned", negate: true }).ids, [works[2]]);

  // Elsewhere 제외 문헌 숨김 still hides a paper marked 제외, and NOT leaves it hidden.
  db.mutate(projectId, [marked, works[2], works[3]], { starred: true });
  const starred = db.list(schemas.list.parse({ projectId, scope: "starred", filters: { ...DEFAULT_FILTERS, include: "ketamine", negate: true } }));
  assert.deepEqual(starred.ids, [works[3]]);
  assert.equal(starred.scoped, 2);

  // Filter, flip, take the flipped papers out: the collection keeps what meets the conditions.
  await service.call("collectionMembers", { projectId, collectionId: collection.id, ids: flipped.ids, remove: true });
  assert.deepEqual(sorted(list().ids), sorted([works[0], marked]));
  assert.equal(list({ ...conditions, negate: true }).total, 0);
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
