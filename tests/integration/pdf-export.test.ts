import { test } from "bun:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { Service } from "../../src/service/service";
import { blankWork } from "../../src/shared/domain";
import {
  AppError,
  type Attachment,
  type PdfExportPreview,
  type PdfExportResult,
} from "../../src/shared/types";
import { hashFile } from "../../src/service/interchange/pdf";
import {
  exportPdfFolders,
  pdfExportTargets,
  planPdfExport,
  previewPdfExport,
} from "../../src/service/interchange/pdf-export";

const fixture = resolve("tests/fixtures/synthetic-local.pdf");
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "rb-pdf-export-"));
  const db = new Library(join(root, "library"));
  return { root, db, projectId: db.projects()[0].id };
}
function work(db: Library, projectId: string, title: string, included = true) {
  const w = db.upsert(blankWork({ title, year: 2024 })).work;
  db.mutate(projectId, [w.id], {
    screening: included ? "included" : "pending",
    note: "private note",
    reading: "reading",
  });
  return w;
}
async function attach(
  db: Library,
  workId: string,
  root: string,
  label: string,
  mode: "managed" | "linked" = "managed",
) {
  const id = randomUUID(),
    source = join(root, id + ".pdf");
  await writeFile(
    source,
    Buffer.concat([
      await readFile(fixture),
      Buffer.from("\n% " + label + "\n"),
    ]),
  );
  const attachment: Attachment = {
    id,
    workId,
    name: label + ".pdf",
    path: source,
    hash: await hashFile(source),
    mode,
    size: (await readFile(source)).length,
    status: "verified",
    exists: true,
  };
  db.saveAttachment(attachment);
  return attachment;
}
function topic(
  db: Library,
  projectId: string,
  id: string,
  name: string,
  workIds: string[] = [],
) {
  db.db
    .prepare("INSERT INTO archive_topics VALUES(?,?,?,?,?)")
    .run(id, projectId, name, "", 0);
  for (const workId of workIds)
    db.db
      .prepare("INSERT INTO archive_topic_works VALUES(?,?,?)")
      .run(projectId, workId, id);
}
const selection = (projectId: string) => ({
  projectId,
  scope: "project" as const,
  ids: [],
});

test("PDF export preserves topic folders, linked and multiple attachments, empty categories and archive state", async () => {
  const { root, db, projectId } = await setup();
  try {
    const a = work(db, projectId, "Classified study"),
      b = work(db, projectId, "Unclassified study"),
      c = work(db, projectId, "No PDF"),
      pending = work(db, projectId, "Pending", false);
    topic(db, projectId, "t1", "정밀 자극", [a.id]);
    topic(db, projectId, "t2", "자살사고", [c.id]);
    const first = await attach(db, a.id, root, "Classified study"),
      second = await attach(db, a.id, root, "Other attachment");
    const linked = await attach(
      db,
      b.id,
      root,
      "External attachment",
      "linked",
    );
    await attach(db, pending.id, root, "Pending file");
    const before = db.db
      .prepare("SELECT * FROM project_works ORDER BY work_id")
      .all();
    const plan = planPdfExport(db, pdfExportTargets(db, selection(projectId))),
      preview = await previewPdfExport(plan);
    assert.equal(preview.workCount, 3);
    assert.equal(preview.pdfCount, 3);
    assert.equal(preview.withoutPdf, 1);
    assert.deepEqual(
      new Set(preview.folders.map((f) => f.path)),
      new Set(["정밀 자극", "자살사고", "미분류"]),
    );
    const result = await exportPdfFolders(plan, root);
    assert.equal(result.pdfCount, 3);
    assert.equal(result.withoutPdf, 1);
    assert.equal(
      await hashFile(
        join(result.path, "정밀 자극", "2024 - Classified study.pdf"),
      ),
      first.hash,
    );
    assert.equal(
      await hashFile(
        join(result.path, "정밀 자극", "2024 - Other attachment.pdf"),
      ),
      second.hash,
    );
    assert.equal(
      await hashFile(
        join(result.path, "미분류", "2024 - External attachment.pdf"),
      ),
      linked.hash,
    );
    assert.deepEqual(await readdir(join(result.path, "자살사고")), []);
    assert.deepEqual(
      db.db.prepare("SELECT * FROM project_works ORDER BY work_id").all(),
      before,
    );
    for (const a of [first, second, linked])
      assert.equal(await hashFile(a.path), a.hash);
    const report = await readFile(result.reportPath, "utf8");
    assert(report.includes('"No PDF"'));
    assert(report.includes('"PDF 없음"'));
    assert(!report.includes("private note"));
    assert(!report.includes(root));
    assert(!report.includes("Pending file"));
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("missing and changed PDFs are reported without blocking later files or mutating attachment records", async () => {
  const { root, db, projectId } = await setup();
  try {
    const a = work(db, projectId, "Missing"),
      b = work(db, projectId, "Changed"),
      c = work(db, projectId, "Valid");
    const missing = await attach(db, a.id, root, "Missing");
    await rm(missing.path);
    const changed = await attach(db, b.id, root, "Changed");
    await writeFile(
      changed.path,
      Buffer.concat([
        await readFile(changed.path),
        Buffer.from("\n% changed\n"),
      ]),
    );
    const valid = await attach(db, c.id, root, "Valid");
    const before = db.db.prepare("SELECT * FROM attachments ORDER BY id").all();
    const result = await exportPdfFolders(
      planPdfExport(db, pdfExportTargets(db, selection(projectId))),
      root,
    );
    assert.equal(result.pdfCount, 1);
    assert.equal(result.withoutPdf, 2);
    assert.equal(result.unavailable, 2);
    assert.equal(
      await hashFile(join(result.path, "미분류", "2024 - Valid.pdf")),
      valid.hash,
    );
    const files = await readdir(join(result.path, "미분류"));
    assert.equal(files.length, 1);
    const report = await readFile(result.reportPath, "utf8");
    assert(report.includes("등록된 첨부와 달라"));
    assert(report.includes("읽을 수 없습니다"));
    assert.deepEqual(
      db.db.prepare("SELECT * FROM attachments ORDER BY id").all(),
      before,
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("unsafe and colliding names stay inside the export, preserve real category names, and never overwrite previous exports", async () => {
  const { root, db, projectId } = await setup();
  try {
    db.db
      .prepare("UPDATE projects SET name=? WHERE id=?")
      .run("../../Project", projectId);
    const a = work(db, projectId, "First"),
      b = work(db, projectId, "Second"),
      c = work(db, projectId, "Third"),
      d = work(db, projectId, "Fourth"),
      e = work(db, projectId, "Fifth");
    topic(db, projectId, "slash", "A/B", [a.id]);
    topic(db, projectId, "colon", "A:B", [b.id]);
    topic(db, projectId, "actual", "미분류", [c.id]);
    await attach(db, a.id, root, "../unsafe");
    await attach(db, b.id, root, "=formula");
    await attach(db, c.id, root, "same");
    await attach(db, d.id, root, "same");
    await attach(db, e.id, root, "SAME");
    const plan = planPdfExport(db, pdfExportTargets(db, selection(projectId)));
    assert(plan.folders.includes("A - B"));
    assert(plan.folders.includes("A - B (2)"));
    assert(plan.folders.includes("미분류"));
    assert(plan.folders.includes("미분류 (2)"));
    const existing = join(root, plan.name);
    await mkdir(existing);
    await writeFile(join(existing, "keep.txt"), "keep");
    const first = await exportPdfFolders(plan, root),
      second = await exportPdfFolders(plan, root);
    assert.equal(first.path, existing + " (2)");
    assert.equal(second.path, existing + " (3)");
    assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "keep");
    assert.equal((await readdir(join(first.path, "미분류 (2)"))).length, 2);
    assert(
      (await readdir(root)).every(
        (name) => !name.startsWith(".researchbunny-export-"),
      ),
    );
    assert(
      plan.folders.every(
        (folder) => !folder.includes("/") && !folder.includes(".."),
      ),
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("all projects retain their own classification for shared papers; selection snapshots exclude later additions and reject removed targets", async () => {
  const { root, db, projectId } = await setup();
  try {
    const other = db.createProject("Other", ""),
      shared = work(db, projectId, "Shared");
    db.mutate(other.id, [shared.id], { screening: "included" });
    topic(db, projectId, "first", "First topic", [shared.id]);
    topic(db, other.id, "second", "Second topic", [shared.id]);
    const attachment = await attach(db, shared.id, root, "Shared");
    const targets = pdfExportTargets(db, { projectId, scope: "all", ids: [] });
    work(db, projectId, "Added after preview");
    const plan = planPdfExport(db, targets),
      result = await exportPdfFolders(plan, root);
    assert.equal(result.workCount, 2);
    assert.equal(result.pdfCount, 2);
    for (const entry of plan.entries)
      assert.equal(
        await hashFile(join(result.path, entry.folder, "2024 - Shared.pdf")),
        attachment.hash,
      );
    const filtered = pdfExportTargets(db, {
      projectId,
      scope: "selected",
      ids: [shared.id, "foreign"],
    });
    assert.deepEqual(filtered[0].ids, [shared.id]);
    db.mutate(projectId, [shared.id], { screening: "trash" });
    assert.throws(
      () => planPdfExport(db, targets),
      (error) => error instanceof AppError && error.code === "EXPORT_TARGET",
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("the service PDF export records the completed result and leaves BibTeX export compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-pdf-export-service-"));
  const service = new Service(
    join(root, "library"),
    resolve("dist/runtime/pdf-worker.cjs"),
    () => {},
  );
  try {
    const db = service.db,
      projectId = db.projects()[0].id,
      a = work(db, projectId, "Service paper");
    await attach(db, a.id, root, "Service paper");
    const preview = (await service.call(
      "pdfExportPreview",
      selection(projectId),
    )) as PdfExportPreview;
    const result = (await service.call("performPdfExport", {
      targets: preview.targets,
      parent: root,
    })) as PdfExportResult;
    assert.equal(result.pdfCount, 1);
    assert.equal(
      (
        db.db.prepare("SELECT count(*) AS n FROM export_records").get() as {
          n: number;
        }
      ).n,
      1,
    );
    const bib = await service.performExport({
      ...selection(projectId),
      path: join(root, "papers.bib"),
    });
    assert.equal(bib.count, 1);
    assert((await readFile(bib.path, "utf8")).includes("Service paper"));
  } finally {
    await service.call("shutdown", {});
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
