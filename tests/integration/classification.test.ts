import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { ArchiveClassifier, archiveWorks, classificationSnapshot, validateClassification } from "../../src/service/archive-classification";
import { AIProvider, DEFAULT_AI } from "../../src/service/providers/openai";
import { blankWork } from "../../src/shared/domain";
import { DEFAULT_FILTERS } from "../../src/shared/types";
import { mergeWorks, undoMerge } from "../../src/service/db/merge";
import { deleteTrashedWorks } from "../../src/service/db/trash";
import { createBackup, restoreBackup } from "../../src/service/interchange/backup";
import { defaultView, restoreNavigation, visitView } from "../../src/shared/navigation";

async function fixture(fn: (db: Library, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-classify-"));
  const db = new Library(join(root, "library"));
  db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: true });
  try { await fn(db, root); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}
const grouped = (indexes: number[]) => ({ topics: [{ reuseTopic: null, name: "유지 치료", description: "재발 예방과 장기 치료", papers: indexes }] });
function add(db: Library, projectId: string, n: number) {
  const { work } = db.upsert(blankWork({ title: `Maintenance treatment ${n}`, doi: `10.1234/classification-${n}`, abstract: "A study of maintenance treatment and relapse prevention." }));
  db.mutate(projectId, [work.id], { screening: "included" });
  return work.id;
}
async function finish(classifier: ArchiveClassifier) {
  for (let i = 0; i < 1000 && classifier.active.size; i++) await Bun.sleep(2);
  assert.equal(classifier.active.size, 0);
}
function list(db: Library, projectId: string, scope: string, scopeId?: string) {
  return db.list({ projectId, scope, scopeId, query: "", filters: DEFAULT_FILTERS, showHidden: false, offset: 0, limit: 100, sort: "title" });
}

test("classification rejects omissions, duplicate/foreign IDs, names, empty groups and >10 topics", () => {
  assert.doesNotThrow(() => validateClassification(grouped([0, 1]), 2));
  for (const raw of [grouped([0]), grouped([0, 0]), grouped([0, 2]), grouped([-1]), grouped([]),
    { topics: [...grouped([0]).topics, ...grouped([1]).topics] },
    { topics: Array.from({ length: 11 }, (_, i) => ({ reuseTopic: null, name: `Topic ${i}`, description: "Topic", papers: [i] })) },
  ]) assert.throws(() => validateClassification(raw, 2));
});

test("button-triggered updates prioritize unclassified papers and can merge/create without exceeding ten", async () => fixture(async db => {
  const projectId = db.projects()[0].id;
  for (let i = 0; i < 10; i++) add(db, projectId, i);
  type Payload = { existingTopics: { index: number; name: string }[]; papers: { index: number; previousTopic: number | null }[] };
  let calls = 0;
  let response: "initial" | "invalid" | "merge" | "append" = "initial";
  const classifier = new ArchiveClassifier(db, { structured: async (_run, _name, _schema, _instruction, data) => {
    calls++;
    const input = data as Payload;
    if (response === "initial") {
      assert.equal(input.existingTopics.length, 0);
      assert(input.papers.every(p => p.previousTopic === null));
      return { topics: input.papers.map(p => ({ reuseTopic: null, name: `Topic ${p.index}`, description: "Research topic", papers: [p.index] })) };
    }
    assert.equal(input.existingTopics.length, 10);
    const fresh = input.papers.filter(p => p.previousTopic === null).map(p => p.index);
    assert.equal(fresh.length, 1);
    const topics = input.existingTopics.map(topic => ({ reuseTopic: topic.index as number | null, name: topic.name, description: "Research topic", papers: input.papers.filter(p => p.previousTopic === topic.index).map(p => p.index) }));
    if (response === "append") { topics[0].papers.push(...fresh); return { topics }; }
    const extra = { reuseTopic: null, name: "New distinct topic", description: "New research area", papers: fresh };
    if (response === "invalid") return { topics: [...topics, extra] };
    const merged = { ...topics[0], name: "Merged and renamed topic", papers: [...topics[0].papers, ...topics[1].papers] };
    return { topics: [extra, merged, ...topics.slice(2)] };
  } }, () => {});
  await Bun.sleep(5);
  assert.equal(calls, 0);
  classifier.start(projectId); await finish(classifier);
  const first = classificationSnapshot(db, projectId).topics;
  const added = add(db, projectId, 11);
  await Bun.sleep(5);
  assert.equal(calls, 1);
  assert.equal(classificationSnapshot(db, projectId).unclassified, 1);
  response = "invalid";
  classifier.start(projectId); await finish(classifier);
  assert.equal(classificationSnapshot(db, projectId).job?.status, "failed");
  assert.deepEqual(classificationSnapshot(db, projectId).topics, first);
  response = "merge";
  classifier.start(projectId); await finish(classifier);
  const merged = classificationSnapshot(db, projectId);
  assert.equal(merged.job?.status, "completed");
  assert.equal(merged.topics.length, 10);
  assert.equal(merged.unclassified, 0);
  assert.equal(merged.topics.reduce((sum, t) => sum + t.count, 0), 11);
  assert.equal(new Set(merged.topics.map(t => t.color)).size, 10);
  assert.equal(merged.topics[0].id, first[0].id);
  assert.equal(merged.topics[0].color, first[0].color);
  assert.equal(merged.topics[0].name, "Merged and renamed topic");
  assert(!merged.topics.some(t => t.id === first[1].id));
  assert.equal(db.view(projectId, added).archiveTopicId, merged.topics.find(t => t.name === "New distinct topic")?.id);
  const other = db.createProject("Other", "");
  db.mutate(other.id, [added], { screening: "included" });
  assert.equal(db.view(other.id, added).archiveTopicId, undefined);
  const beforeAssignments = archiveWorks(db, projectId).map(w => [w.id, db.view(projectId, w.id).archiveTopicId]);
  add(db, projectId, 12);
  response = "append";
  classifier.start(projectId); await finish(classifier);
  for (const [id, topic] of beforeAssignments) assert.equal(db.view(projectId, id!).archiveTopicId, topic);
  assert.equal(classificationSnapshot(db, projectId).unclassified, 0);
  assert.equal(classificationSnapshot(db, projectId).topics.length, 10);
}));

test("classification rejects unknown or multiply reused topic identities", () => {
  const topic = { ...grouped([0]).topics[0], reuseTopic: 0 };
  assert.throws(() => validateClassification({ topics: [topic] }, 1));
  assert.throws(() => validateClassification({ topics: [topic, { ...topic, name: "Other", papers: [1] }] }, 2, 1));
  assert.doesNotThrow(() => validateClassification({ topics: [topic] }, 1, 1));
});

test("AI provider classifies whole archive, preserves collections, isolates projects and survives backup", async () => fixture(async (db, root) => {
  const projectId = db.projects()[0].id;
  const ids = [add(db, projectId, 1), add(db, projectId, 2)];
  const other = db.createProject("Other", "");
  add(db, other.id, 3);
  const pending = add(db, projectId, 4);
  db.mutate(projectId, [pending], { screening: "pending" });
  const collection = db.createCollection(projectId, "Manual");
  db.db.prepare("INSERT INTO collection_works VALUES(?,?)").run(collection.id, ids[0]);
  db.mutate(projectId, [ids[0]], { note: "PRIVATE NOTE" });
  const provider = new AIProvider(db, () => undefined, () => ({ ...DEFAULT_AI, aiProvider: "codex", aiEnabled: true }), fetch, {
    complete: async request => {
      assert(!request.input.includes("PRIVATE NOTE"));
      const data = JSON.parse(request.input);
      assert.equal(data.papers.length, 2);
      return JSON.stringify(grouped(data.papers.map((p: { index: number }) => p.index)));
    },
  });
  const classifier = new ArchiveClassifier(db, provider, () => {});
  assert.equal(classifier.start(projectId).status, "running");
  assert.throws(() => classifier.start(projectId), /진행 중/);
  await finish(classifier);
  const result = classificationSnapshot(db, projectId);
  assert.equal(result.job?.status, "completed");
  assert.equal(result.topics[0].count, 2);
  assert.equal(result.unclassified, 0);
  assert.deepEqual(new Set(list(db, projectId, "topic", result.topics[0].id).ids), new Set(ids));
  assert.equal(list(db, other.id, "topic", result.topics[0].id).total, 0);
  assert.equal(db.collections(projectId)[0].count, 1);
  assert.equal(db.runs().length, 0);
  assert.equal(db.usageSummary()[0].calls, 1);
  const fresh = add(db, projectId, 5);
  assert.deepEqual(list(db, projectId, "unclassified").ids, [fresh]);
  db.mutate(projectId, [ids[0]], { screening: "trash" });
  assert.equal(classificationSnapshot(db, projectId).topics[0].count, 1);
  db.mutate(projectId, [ids[0]], { screening: "included" });
  assert.equal(classificationSnapshot(db, projectId).topics[0].count, 2);
  await createBackup(db, join(root, "backup"), false, false);
  await restoreBackup(join(root, "backup"), join(root, "restored"));
  const restored = new Library(join(root, "restored"));
  try { assert.deepEqual(classificationSnapshot(restored, projectId), classificationSnapshot(db, projectId)); } finally { restored.close(); }
}));

test("failed, cancelled and stale classification never overwrite the previous tree", async () => fixture(async db => {
  const projectId = db.projects()[0].id;
  add(db, projectId, 1);
  const good = new ArchiveClassifier(db, { structured: async () => grouped([0]) }, () => {});
  good.start(projectId); await finish(good);
  const original = classificationSnapshot(db, projectId).topics;
  for (const scenario of ["invalid", "cancel", "changed", "network"] as const) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const classifier = new ArchiveClassifier(db, { structured: async () => {
      await gate;
      if (scenario === "network") throw new Error("Provider offline");
      return grouped(scenario === "invalid" ? [1] : [0]);
    } }, () => {});
    classifier.start(projectId);
    if (scenario === "cancel") classifier.cancel(projectId);
    if (scenario === "changed") add(db, projectId, 2);
    release(); await finish(classifier);
    assert.deepEqual(classificationSnapshot(db, projectId).topics, original);
    assert.equal(classificationSnapshot(db, projectId).job?.status, scenario === "cancel" ? "cancelled" : "failed");
  }
}));

test("merge, undo and permanent deletion retain valid topic memberships", async () => fixture(async db => {
  const projectId = db.projects()[0].id;
  const keep = add(db, projectId, 1), remove = add(db, projectId, 2);
  const classifier = new ArchiveClassifier(db, { structured: async () => grouped([0, 1]) }, () => {});
  classifier.start(projectId); await finish(classifier);
  const topicId = classificationSnapshot(db, projectId).topics[0].id;
  mergeWorks(db, keep, remove);
  assert.deepEqual(list(db, projectId, "topic", topicId).ids, [keep]);
  assert.equal(undoMerge(db), true);
  assert.equal(list(db, projectId, "topic", topicId).total, 2);
  db.mutate(projectId, [remove], { screening: "trash" });
  deleteTrashedWorks(db, projectId, [remove]);
  assert.deepEqual(list(db, projectId, "topic", topicId).ids, [keep]);
  assert.equal(db.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM archive_topic_works WHERE work_id=?").get(remove)?.n, 0);
  assert.deepEqual(db.db.pragma("foreign_key_check"), []);
}));

test("disabled, empty and oversized archives fail before any provider call; interrupted jobs recover", async () => fixture(async db => {
  const projectId = db.projects()[0].id;
  let calls = 0;
  const classifier = new ArchiveClassifier(db, { structured: async () => { calls++; return grouped([0]); } }, () => {});
  assert.throws(() => classifier.start(projectId), /논문이 없습니다/);
  add(db, projectId, 1);
  db.pref("ai", { ...DEFAULT_AI, aiEnabled: false });
  assert.throws(() => classifier.start(projectId), /활성화/);
  db.pref("ai", { ...DEFAULT_AI, aiEnabled: true, aiMaxInputTokens: 1000 });
  assert.throws(() => classifier.start(projectId), /예산/);
  assert.equal(calls, 0);
  db.pref(`classification:${projectId}`, { status: "running", message: "", updatedAt: "" });
  new ArchiveClassifier(db, { structured: async () => grouped([0]) }, () => {});
  assert.equal(classificationSnapshot(db, projectId).job?.status, "interrupted");
}));

test("large archives include all titles while trimming abstracts to the configured budget", async () => fixture(async db => {
  const projectId = db.projects()[0].id;
  for (let i = 0; i < 76; i++) {
    const id = add(db, projectId, i);
    db.edit(id, { abstract: "Long abstract. ".repeat(400) });
    const work = db.get(id);
    work.topics = Array.from({ length: 5 }, (_, index) => ({ id: `T${index}`, name: "Long provider topic name. ".repeat(10) }));
    db.db.prepare("UPDATE works SET data=? WHERE id=?").run(JSON.stringify(work), id);
  }
  const classifier = new ArchiveClassifier(db, { structured: async (_run, _name, _schema, _instruction, data) => {
    const payload = data as { papers: { index: number; title: string; abstract: string | null }[] };
    assert.equal(payload.papers.length, 76);
    assert(payload.papers.every(p => p.title.length > 0));
    assert(Buffer.byteLength(JSON.stringify(data)) < DEFAULT_AI.aiMaxInputTokens);
    return grouped(payload.papers.map(p => p.index));
  } }, () => {});
  classifier.start(projectId); await finish(classifier);
  assert.equal(classificationSnapshot(db, projectId).topics[0].count, archiveWorks(db, projectId).length);
}));

test("topic navigation survives history persistence", () => {
  const archive = defaultView();
  const topic = defaultView({ scope: "topic", scopeId: "topic-1" });
  const history = visitView(restoreNavigation({}), archive, topic);
  assert.equal(restoreNavigation({ navigation: history }).views["topic:topic-1"].scope, "topic");
});
