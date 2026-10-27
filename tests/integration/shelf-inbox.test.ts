import { test, expect } from "bun:test";
import { copyFile, mkdtemp, mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../../src/service/service";
import { blankWork } from "../../src/shared/domain";
import { formatShelfFilename, parseShelfFilename } from "../../src/shared/shelf";
import { hasValidPdf, hashFile } from "../../src/service/interchange/pdf";
import type { RetrievedPdf } from "../../src/service/fulltext/engine";
import type { Page } from "../../src/service/providers/openalex";
import { AppError, type Run, type Work } from "../../src/shared/types";

const worker = resolve("dist/runtime/pdf-worker.cjs");
const OLD = "01 Domain/2020 - Old - An older paper already on the shelf.pdf";

async function pdf(path: string, lines: string[]) {
  const stream = `BT /F1 11 Tf 40 760 Td ${lines.map((line, i) => `${i ? "0 -16 Td " : ""}(${line.replace(/[()\\]/g, "")}) Tj`).join("\n")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    `<< /Title (${lines[0].replace(/[()\\]/g, "")}) >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, out);
  return path;
}
const paper = (title: string) => [title, "Ada Lovelace, Charles Babbage", "Abstract This study reports a reproducible result about analytical engines."];

async function fixture(fn: (ctx: { service: Service; shelf: string; root: string; projectId: string; calls: { oa: number } }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "rb-inbox-"));
  const shelf = join(root, "Articles");
  await pdf(join(shelf, OLD), paper("An older paper already on the shelf"));
  const service = new Service(join(root, "library"), worker, () => {});
  const calls = { oa: 0 };
  const empty = (): Page => ({ works: [], cursor: null, total: 0, cached: false, fetchedAt: new Date().toISOString() });
  service.oa.page = async (_params: Record<string, string>, _signal: AbortSignal, onCall: () => void) => { onCall(); calls.oa++; return empty(); };
  service.oa.lookup = async (_identifier: string, _signal: AbortSignal, onCall: () => void) => { onCall(); calls.oa++; throw new Error("not found"); };
  try {
    await service.call("shelfConfigure", { path: shelf, ollamaUrl: "http://127.0.0.1:9" });
    await service.shelf.wait();
    await fn({ service, shelf, root, projectId: service.db.projects()[0].id, calls });
  } finally {
    service.shelf.stop();
    await service.shelf.wait();
    service.downloads.stopRecoveryMonitor();
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
}
const fileOf = (service: Service, rel: string) =>
  (service.db.db.prepare("SELECT * FROM shelf_files WHERE rel_path=?").get(rel) ?? undefined) as { id: string; work_id: string; status: string; stage: string; info: string; attachment_id: string | null } | undefined;
function archived(service: Service, projectId: string, fields: Partial<Work>) {
  const work = service.db.upsert(blankWork({ citekey: "", ...fields })).work;
  service.db.mutate(projectId, [work.id], { screening: "included" });
  return work;
}
async function finished(service: Service) {
  while (service.downloads.active.size || service.pdf.active.size) await Bun.sleep(10);
}
/** Engine stub: "downloads" a prepared PDF and runs the job's own validation. */
function serve(service: Service, source: () => string) {
  service.downloads["engine"].retrieve = async (_work: Work, path: string, _signal: AbortSignal, _progress: (m: string) => void, validate: (c: RetrievedPdf) => Promise<void>) => {
    await copyFile(source(), path);
    const candidate: RetrievedPdf = { sourceUrl: "https://example.org/paper.pdf", doi: null, method: "http" };
    await validate(candidate);
    return candidate;
  };
}

test("inbox names follow the shelf's 연도 - 저자 - 제목 convention", () => {
  expect(formatShelfFilename({ year: 2024, authors: ["John Smith"], title: "Interoception: a review?" })).toBe("2024 - Smith - Interoception; a review.pdf");
  expect(formatShelfFilename({ year: 2023, authors: ["Min Kim", "Jae Lee"], title: "Dopamine <i>in vivo</i> dynamics." })).toBe("2023 - Kim, Lee - Dopamine in vivo dynamics.pdf");
  expect(formatShelfFilename({ year: 2022, authors: ["Wouter van der Wal", "B Two", "C Three"], title: "A/B testing" })).toBe("2022 - Wal et al. - AB testing.pdf");
  expect(formatShelfFilename({ year: 2021, authors: ["YANAGISAWA, Taro", "Lee, J"], title: "Sleep" })).toBe("2021 - Yanagisawa, Lee - Sleep.pdf");
  expect(formatShelfFilename({ year: null, authors: [], title: "Untitled scan" })).toBe("n.d. - Unknown - Untitled scan.pdf");
  const long = formatShelfFilename({ year: 2026, authors: ["A Blumberger", "B Two", "C Three"], title: "Confirmatory efficacy and safety trial of magnetic seizure therapy ".repeat(6) });
  expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(240);
  expect(long).toEndWith("therapy ....pdf");
  expect(parseShelfFilename("2024 - Smith - Interoception; a review.pdf")).toEqual({ year: 2024, authors: ["Smith"], title: "Interoception; a review" });
  expect(parseShelfFilename("n.d. - Unknown - Untitled scan.pdf")).toEqual({ year: null, authors: [], title: "Untitled scan" });
});

test("downloads are stored in the inbox under the shelf name, registered without lookups and followed when filed", async () => {
  await fixture(async ({ service, shelf, root, projectId, calls }) => {
    const source = await pdf(join(root, "src/first.pdf"), paper("Analytical engines and reproducible results"));
    const work = archived(service, projectId, { title: "Analytical engines and reproducible results", authors: ["Ada Lovelace", "Charles Babbage", "Mary Somerville"], year: 2025 });
    serve(service, () => source);
    const run: Run = await service.call("downloadPdfs", { projectId, scope: "archive" });
    await finished(service);
    const name = "2025 - Lovelace et al. - Analytical engines and reproducible results.pdf";
    const item = service.db.run(run.id).download!.items[0];
    expect(item.status).toBe("completed");
    expect(item.message).toBe(`PDF 확보·검증 · 서고 수신함에 저장 (${name})`);
    expect((await readdir(shelf)).sort()).toEqual(["01 Domain", name]);
    expect(await readdir(join(service.db.root, "attachments"))).toEqual([]);
    const [attachment] = service.db.attachments(work.id);
    expect(attachment).toMatchObject({ mode: "linked", path: join(shelf, name), hash: await hashFile(source), sourceUrl: "https://example.org/paper.pdf", retrievalMethod: "http" });
    const row = fileOf(service, name)!;
    expect(row).toMatchObject({ work_id: work.id, status: "ok", stage: "hashed", attachment_id: attachment.id });
    expect(JSON.parse(row.info).resolution.method).toBe("app");
    expect(await hasValidPdf(service.db, work.id)).toBe(true);
    expect((await service.call("shelfStatus", {})).summary.inbox).toBe(1);

    // The next scan extracts it without asking OpenAlex again and drops stale temporary files.
    const stale = join(shelf, ".researchbunny-stale.part"), fresh = join(shelf, ".researchbunny-fresh.part");
    await writeFile(stale, "x");
    await writeFile(fresh, "x");
    await utimes(stale, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    const before = calls.oa;
    await service.shelf.scan("test");
    expect(calls.oa).toBe(before);
    expect(fileOf(service, name)!.stage).toBe("resolved");
    expect((await readdir(shelf)).filter((n) => n.startsWith("."))).toEqual([".researchbunny-fresh.part"]);

    // intake.py files it into a folder: the one attachment follows the move.
    await rename(join(shelf, name), join(shelf, "01 Domain", name));
    await service.shelf.scan("test");
    expect(service.db.attachments(work.id)).toHaveLength(1);
    expect(service.db.attachments(work.id)[0].path).toBe(join(shelf, "01 Domain", name));
    expect(await hasValidPdf(service.db, work.id)).toBe(true);

    // A different paper whose shelf name is taken gets " (2)", as intake.py numbers clashes.
    await copyFile(join(shelf, "01 Domain", name), join(shelf, name));
    const twin = archived(service, projectId, { title: "Analytical engines and reproducible results", authors: ["Ada Lovelace", "B Two", "C Three"], year: 2025 });
    const other = await pdf(join(root, "src/second.pdf"), [...paper("Analytical engines and reproducible results"), "Second edition"]);
    serve(service, () => other);
    service.downloads["shelf"]!.match = () => [];
    await service.call("downloadPdfs", { projectId, scope: "selected", ids: [twin.id] });
    await finished(service);
    expect(service.db.attachments(twin.id)[0].path).toBe(join(shelf, "2025 - Lovelace et al. - Analytical engines and reproducible results (2).pdf"));
  });
});

test("Chrome downloads move to the shelf, and a recovered download leaves the Downloads folder once stored", async () => {
  await fixture(async ({ service, shelf, root, projectId }) => {
    const downloads = join(root, "Downloads");
    await mkdir(downloads, { recursive: true });
    const direct = archived(service, projectId, { title: "Chrome retrieved paper on engines", authors: ["Ada Lovelace"], year: 2024 });
    service.downloads["engine"].retrieve = async () => { throw new AppError("NO_PDF", "no public PDF"); };
    // The app's Chrome saves into the run's staging, never the person's Downloads.
    service.downloads["browser"] = {
      async retrieve(_work, path, _signal, _progress, validate, { downloads: staging }) {
        const saved = await pdf(join(staging, "guid"), paper("Chrome retrieved paper on engines"));
        await copyFile(saved, path);
        const candidate: RetrievedPdf = { sourceUrl: "https://publisher.example/s41586.pdf", doi: null, method: "chrome", requireIdentity: true };
        await validate(candidate);
        return candidate;
      },
    };
    await service.call("downloadPdfs", { projectId, scope: "selected", ids: [direct.id], useBrowser: true, downloadDirectory: downloads });
    await finished(service);
    expect(service.db.attachments(direct.id)[0]).toMatchObject({ mode: "linked", retrievalMethod: "chrome", path: join(shelf, "2024 - Lovelace - Chrome retrieved paper on engines.pdf") });
    expect(await readdir(downloads)).toEqual([]);

    // A file the user saved from Chrome after a failed attempt is recovered, filed and removed from Downloads.
    const late = archived(service, projectId, { title: "Late arriving paper about difference engines", authors: ["Charles Babbage", "Ada Lovelace"], year: 2023 });
    service.downloads["browser"] = { async retrieve() { throw new AppError("CHROME_UNAVAILABLE", "not found"); } };
    const run: Run = await service.call("downloadPdfs", { projectId, scope: "selected", ids: [late.id], useBrowser: true, downloadDirectory: downloads });
    await finished(service);
    expect(service.db.run(run.id).download!.items[0].status).toBe("failed");
    const saved = await pdf(join(downloads, "late-download.pdf"), paper("Late arriving paper about difference engines"));
    await utimes(saved, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    await service.downloads.recoverCompleted();
    expect(service.db.run(run.id).download!.items[0]).toMatchObject({ status: "completed", downloadedPath: saved });
    expect(service.db.attachments(late.id)[0].path).toBe(join(shelf, "2023 - Babbage, Lovelace - Late arriving paper about difference engines.pdf"));
    expect(await readdir(downloads)).toEqual([]);
  });
});

test("an offline shelf stops downloads and imports instead of keeping a second store", async () => {
  await fixture(async ({ service, shelf, root, projectId }) => {
    const source = await pdf(join(root, "src/offline.pdf"), paper("Offline shelf paper on engines"));
    const work = archived(service, projectId, { title: "Offline shelf paper on engines", authors: ["Ada Lovelace"], year: 2022 });
    await rename(shelf, shelf + "-unmounted");
    await expect(service.call("downloadPdfs", { projectId, scope: "archive" })).rejects.toMatchObject({ code: "SHELF_OFFLINE" });
    await expect(service.call("pdfImport", { projectId, paths: [source], options: { mode: "managed", workId: work.id } })).rejects.toMatchObject({ code: "SHELF_OFFLINE" });
    await rename(shelf + "-unmounted", shelf);

    // The share drops during a run: the run stops, nothing goes to the app's folder, and it resumes later.
    serve(service, () => source);
    const retrieve = service.downloads["engine"].retrieve.bind(service.downloads["engine"]);
    service.downloads["engine"].retrieve = async (...args: Parameters<typeof retrieve>) => {
      const result = await retrieve(...args);
      await rename(shelf, shelf + "-unmounted");
      return result;
    };
    const run: Run = await service.call("downloadPdfs", { projectId, scope: "archive" });
    await finished(service);
    expect(service.db.run(run.id).status).toBe("failed");
    expect(service.db.run(run.id).download!.items.find((i) => i.workId === work.id)).toMatchObject({ status: "pending" });
    expect(await readdir(join(service.db.root, "attachments"))).toEqual([]);
    expect(service.db.attachments(work.id)).toEqual([]);
    await rename(shelf + "-unmounted", shelf);
    serve(service, () => source);
    await service.call("controlRun", { runId: run.id, action: "resume" });
    await finished(service);
    expect(service.db.run(run.id).download!.items.find((i) => i.workId === work.id)!.status).toBe("completed");
    expect(service.db.attachments(work.id)[0].path).toBe(join(shelf, "2022 - Lovelace - Offline shelf paper on engines.pdf"));
  });
});

test("PDFs kept in the app's folder move to the inbox; identical shelf bytes are linked and other shelf copies are kept", async () => {
  await fixture(async ({ service, shelf, root, projectId }) => {
    const store = join(service.db.root, "attachments");
    const keep = async (work: Work, source: string) => {
      const hash = await hashFile(source), path = join(store, hash + ".pdf");
      await copyFile(source, path);
      service.db.saveAttachment({ id: crypto.randomUUID(), workId: work.id, name: work.title + ".pdf", path, hash, mode: "managed", size: (await stat(path)).size, status: "원문 확보 · PDF 검증됨", exists: true, sourceUrl: "https://example.org/kept.pdf" });
      return path;
    };
    const fresh = archived(service, projectId, { title: "A fresh paper only the app had", authors: ["Mary Somerville"], year: 2021 });
    const freshPath = await keep(fresh, await pdf(join(root, "src/fresh.pdf"), paper("A fresh paper only the app had")));
    const same = archived(service, projectId, { title: "An older paper already on the shelf (project copy)", authors: ["Old"], year: 2020 });
    const samePath = await keep(same, join(shelf, OLD));
    const old = fileOf(service, OLD)!;
    const other = archived(service, projectId, { title: "Shelf paper with another download", authors: ["Ada Lovelace"], year: 2019 });
    service.shelf.attachTo(old.id, other.id);
    const otherPath = await keep(other, await pdf(join(root, "src/other.pdf"), paper("Shelf paper with another download")));
    expect((await service.call("shelfStatus", {})).managed).toBe(3);

    const result = await service.call("shelfAdopt", {});
    expect(result).toEqual({ moved: 1, linked: 1, kept: [other.id], failed: [] });
    const freshName = "2021 - Somerville - A fresh paper only the app had.pdf";
    expect(service.db.attachments(fresh.id)).toEqual([expect.objectContaining({ mode: "linked", path: join(shelf, freshName), sourceUrl: "https://example.org/kept.pdf", status: "앱 보관 PDF · 서고 수신함으로 옮김" })]);
    expect(JSON.parse(fileOf(service, freshName)!.info).resolution.method).toBe("hash");
    expect(service.db.attachments(same.id)).toEqual([expect.objectContaining({ mode: "linked", shelfFileId: old.id, path: join(shelf, OLD) })]);
    expect(service.db.attachments(other.id).map((a) => a.mode).sort()).toEqual(["linked", "managed"]);
    expect(await Bun.file(freshPath).exists()).toBe(false);
    expect(await Bun.file(samePath).exists()).toBe(false);
    expect(await Bun.file(otherPath).exists()).toBe(true);
    expect((await readdir(shelf)).sort()).toEqual(["01 Domain", freshName]);
    expect((await service.call("shelfStatus", {})).managed).toBe(1);
    for (const work of [fresh, same, other]) expect(await hasValidPdf(service.db, work.id)).toBe(true);
  });
});

test("attaching or matching a PDF by hand stores a copy in the inbox and keeps the user's file", async () => {
  await fixture(async ({ service, shelf, root, projectId }) => {
    const work = archived(service, projectId, { title: "Hand attached paper about looms", authors: ["Joseph Jacquard", "Ada Lovelace"], year: 2018 });
    const source = await pdf(join(root, "Desktop/looms.pdf"), paper("Hand attached paper about looms"));
    await service.call("pdfImport", { projectId, paths: [source], options: { mode: "managed", workId: work.id } });
    await finished(service);
    const name = "2018 - Jacquard, Lovelace - Hand attached paper about looms.pdf";
    expect(service.db.attachments(work.id)).toEqual([expect.objectContaining({ mode: "linked", path: join(shelf, name) })]);
    expect(await Bun.file(source).exists()).toBe(true);
    expect(await readdir(join(service.db.root, "attachments"))).toEqual([]);
  });
});
