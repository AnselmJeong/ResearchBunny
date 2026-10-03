import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import { ArticleChat } from "../../src/service/chat/service";
import { PdfReader, bodyWithoutReferences } from "../../src/service/interchange/pdf-reader";
import { hashFile } from "../../src/service/interchange/pdf";
import { DEFAULT_AI } from "../../src/service/providers/openai";
import { schemas } from "../../src/shared/contracts";
import type { ArticleContext, ChatContextRef, ChatSession } from "../../src/shared/chat";
import { createBackup, restoreBackup } from "../../src/service/interchange/backup";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bunny-reader-"));
  const db = new Library(root);
  cleanups.push(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const projectId = db.projects()[0].id;
  const work = db.upsert(blankWork({ title: "Original paper", abstract: "ABSTRACT ONLY" })).work;
  db.ensureMembership(projectId, work.id);
  const path = join(root, "article.pdf");
  // Deliberately different page-one metadata, later results, and references.
  const pages = ["First page introduction.\n".repeat(20).trim(), "SECOND_PAGE_RESULT 42.\n".repeat(20).trim(), "References\nREFERENCE_SECRET 1984"];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 3 /Kids [4 0 R 6 0 R 8 0 R] >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i = 0; i < pages.length; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = `BT /F1 12 Tf 50 740 Td ${pages[i].split('\n').map((line, j) => `${j ? '0 -20 Td ' : ''}(${line}) Tj`).join('\n')} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await writeFile(path, pdf);
  const attachmentId = "primary-pdf";
  db.saveAttachment({ id: attachmentId, workId: work.id, hash: await hashFile(path), path, name: "article.pdf", mode: "linked", exists: true, size: Buffer.byteLength(pdf), status: "extracted" });
  const target = { projectId, workId: work.id, attachmentId };
  const context: ChatContextRef = { kind: "pdf-fulltext", attachmentId };
  const reader = new PdfReader(db, resolve("dist/pdf-worker.cjs"));
  return { db, root, target, context, reader, path };
}
async function completed(chat: ArticleChat, target: { projectId: string; workId: string }, context?: ChatContextRef, threadId?: string) {
  for (let i = 0; i < 300; i++) { const s = chat.session(target.projectId, target.workId, context, threadId); if (!s.activeRequestId) return s; await Bun.sleep(10); }
  throw new Error("unfinished");
}
const config = { ...DEFAULT_AI, aiEnabled: true, aiMaxInputTokens: 200000 };

test("reader resolves registered PDF chunks and extracts later pages excluding references", async () => {
  const { reader, target, context, db, path } = await fixture();
  const info = await reader.info(target);
  const chunk = await reader.chunk({ ...target, offset: 0, length: 64 });
  expect(Buffer.from(chunk.base64, "base64").toString()).toStartWith("%PDF");
  expect(chunk.bytesRead).toBe(64);
  const resolved = await reader.context(target, new AbortController().signal);
  expect(resolved).toMatchObject({ kind: "pdf-fulltext", referencesExcluded: true, pageCount: 3, attachmentHash: info.hash });
  expect(resolved.text).toContain("SECOND_PAGE_RESULT 42");
  expect(resolved.text).not.toContain("REFERENCE_SECRET");
  const other = db.upsert(blankWork({ title: "Other" })).work;
  db.ensureMembership(target.projectId, other.id);
  await expect(reader.info({ ...target, workId: other.id })).rejects.toThrow("첨부");
  const otherProject = db.createProject("Other project", "");
  await expect(reader.info({ ...target, projectId: otherProject.id })).rejects.toThrow("프로젝트");
  expect(schemas.pdfInfo.safeParse({ ...target, path: "/private/file" }).success).toBe(false);
  expect(schemas.pdfReadChunk.safeParse({ ...target, offset: -1, length: 99 }).success).toBe(false);
  expect(schemas.chatSend.safeParse({ ...target, context: { ...context, text: "untrusted", referencesExcluded: true }, requestId: "x", message: "x", searchEnabled: false }).success).toBe(false);
  await writeFile(path, "%PDF-1.4\nchanged");
  await expect(reader.info(target)).rejects.toThrow("변경");
});

test("reference detection keeps ordinary prose and discloses unknown boundary", () => {
  const body = "The references in our methods are not a section heading. ".repeat(10);
  expect(bodyWithoutReferences(body)).toEqual({ text: body.trim(), referencesExcluded: false });
  expect(bodyWithoutReferences(body + "\n9. References\nCitation").text).toBe(body.trim());
  expect(bodyWithoutReferences(body + "\n참고문헌\nCitation").referencesExcluded).toBe(true);
});

test("PDF and abstract conversations stay independent; new threads preserve accessible DB history", async () => {
  const { db, target, context, reader } = await fixture();
  const prompts: { articleContext: ArticleContext; conversation: unknown[] }[] = [];
  const chat = new ArticleChat(db, () => config, () => ({}), { async *stream(_c, _i, input) { prompts.push(JSON.parse(input)); yield "Saved answer"; } }, () => {}, undefined,
    (projectId, workId, attachmentId, signal) => reader.context({ projectId, workId, attachmentId }, signal));
  chat.start({ ...target, requestId: "abstract-1", message: "Browse question", searchEnabled: false });
  const abstract = await completed(chat, target);
  chat.start({ ...target, context, requestId: "pdf-1", message: "PDF question", searchEnabled: false });
  const full = await completed(chat, target, context);
  expect(full.threadId).not.toBe(abstract.threadId);
  expect(prompts[1].conversation).toEqual([]);
  expect(prompts[1].articleContext.text).not.toContain("ABSTRACT ONLY");
  const evidence = db.db.prepare("SELECT data FROM chat_contexts WHERE thread_id=? AND message_id=?").get(full.threadId, "pdf-1") as { data: string };
  expect(JSON.parse(evidence.data).text).toContain("SECOND_PAGE_RESULT");
  expect(full.messages[1].context).toBeUndefined();
  chat.start({ ...target, requestId: "abstract-2", message: "Browse again", searchEnabled: false });
  await completed(chat, target);
  expect(JSON.stringify(prompts[2].conversation)).toContain("Browse question");
  expect(JSON.stringify(prompts[2].conversation)).not.toContain("PDF question");
  const fresh = chat.clear(target.projectId, target.workId, context);
  expect(fresh.threadId).not.toBe(full.threadId);
  expect(chat.threads(target.projectId, target.workId, context)).toHaveLength(2);
  expect(chat.session(target.projectId, target.workId, context, full.threadId).messages).toEqual(full.messages);
  expect(() => chat.session(target.projectId, target.workId, { kind: "abstract" }, full.threadId)).toThrow("문맥");
  const restored = new Library(db.root);
  try {
    const reloaded = new ArticleChat(restored, () => config, () => ({}), { async *stream() { yield "unused"; } }, () => {});
    expect(reloaded.session(target.projectId, target.workId, context, full.threadId).messages).toEqual(full.messages);
    expect(reloaded.session(target.projectId, target.workId, context).threadId).toBe(fresh.threadId);
    reloaded.select(target.projectId, target.workId, context, full.threadId);
    expect(reloaded.session(target.projectId, target.workId, context).threadId).toBe(full.threadId);
  } finally { restored.close(); }
});

test("stream checkpoints survive restart; cancellation and sources target the originating context", async () => {
  const { db, target, context } = await fixture();
  const pdf: ArticleContext = { kind: "pdf-fulltext", workId: target.workId, title: "Paper", text: "Body", attachmentId: target.attachmentId, attachmentHash: "hash", referencesExcluded: false, pageCount: 1, notice: "No boundary" };
  const chat = new ArticleChat(db, () => config, () => ({}), { async *stream(_c, _i, _p, signal) {
    yield "Persist this partial answer";
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
    signal.throwIfAborted();
  } }, () => {}, undefined, async () => pdf);
  const abstract = chat.start({ ...target, requestId: "running-abstract", message: "Abstract", searchEnabled: false });
  const full = chat.start({ ...target, context, requestId: "running-pdf", message: "Full text", searchEnabled: false });
  await Bun.sleep(30);
  const row = db.db.prepare("SELECT data FROM chat_threads WHERE id=?").get(full.threadId) as { data: string };
  expect(JSON.parse(row.data).messages[1].content).toBe("Persist this partial answer");
  chat.cancel(target.projectId, target.workId, "running-pdf", context, full.threadId);
  expect((await completed(chat, target, context)).messages[1].status).toBe("cancelled");
  expect(chat.session(target.projectId, target.workId).activeRequestId).toBe("running-abstract");
  chat.cancel(target.projectId, target.workId, "running-abstract");
  await completed(chat, target);
  const saved: ChatSession = JSON.parse(row.data);
  db.db.prepare("UPDATE chat_threads SET data=? WHERE id=?").run(JSON.stringify(saved), full.threadId);
  const restarted = new ArticleChat(db, () => config, () => ({}), { async *stream() { yield "unused"; } }, () => {});
  expect(restarted.session(target.projectId, target.workId, context).messages[1]).toMatchObject({ content: "Persist this partial answer", status: "cancelled" });
  expect(restarted.session(target.projectId, target.workId, undefined, abstract.threadId).messages).toHaveLength(2);
});

test("PDF extraction failures preserve questions without falling back to abstract", async () => {
  const { db, target, context } = await fixture();
  let calls = 0;
  const chat = new ArticleChat(db, () => config, () => ({}), { async *stream() { calls++; yield "should not run"; } }, () => {}, undefined, async () => { throw new Error("Scanned PDF needs OCR"); });
  chat.start({ ...target, context, requestId: "failed-pdf", message: "Keep my question", searchEnabled: false });
  const final = await completed(chat, target, context);
  expect(calls).toBe(0);
  expect(final.messages[0].content).toBe("Keep my question");
  expect(final.messages[1]).toMatchObject({ status: "failed", notice: "Scanned PDF needs OCR" });
});

test("existing SQLite conversations migrate once and new and old threads survive backup/restore", async () => {
  const { db, root, target } = await fixture();
  const key = `article-chat:${JSON.stringify([target.projectId, target.workId])}`;
  const messages: ChatSession["messages"] = [{ id: "legacy-message", role: "user", content: "Historical question", createdAt: "2026-10-01", status: "complete" }];
  db.pref(key, { ...target, messages, activeRequestId: null, phase: "", revision: 3 });
  const chat = new ArticleChat(db, () => config, () => ({}), { async *stream() { yield "Answer"; } }, () => {});
  const legacy = chat.session(target.projectId, target.workId);
  expect(legacy.messages).toEqual(messages);
  const current = chat.clear(target.projectId, target.workId);
  expect(current.messages).toEqual([]);
  expect(chat.session(target.projectId, target.workId).messages).toEqual([]);
  expect(db.pref(key)).toBeDefined();
  const backup = await createBackup(db, join(root, "backup"), true, true);
  await restoreBackup(backup.path, join(root, "restored"));
  const restored = new Library(join(root, "restored"));
  try {
    const loaded = new ArticleChat(restored, () => config, () => ({}), { async *stream() { yield "unused"; } }, () => {});
    expect(loaded.threads(target.projectId, target.workId)).toHaveLength(2);
    expect(loaded.session(target.projectId, target.workId, undefined, legacy.threadId).messages).toEqual(messages);
  } finally { restored.close(); }
});
