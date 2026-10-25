import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import { hashFile } from "../../src/service/interchange/pdf";
import { GenealogyAI } from "../../src/service/genealogy/llm";
import { GenealogyStore } from "../../src/service/genealogy/store";
import { GenealogyEngine, type EngineDeps } from "../../src/service/genealogy/engine";
import { defaultGenealogySettings, type GenealogySettings } from "../../src/shared/genealogy";
import { DEFAULT_AI } from "../../src/service/providers/openai";
import type { AppEvent, Work } from "../../src/shared/types";
import type { Page } from "../../src/service/providers/openalex";

export const WORKER = resolve("dist/runtime/pdf-worker.cjs");

/** A text-only PDF whose pages hold the given lines. */
export async function makePdf(path: string, pages: string[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i = 0; i < pages.length; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = `BT /F1 10 Tf 40 760 Td ${pages[i].split("\n").map((line, j) => `${j ? "0 -14 Td " : ""}(${line.replace(/[()\\]/g, "")}) Tj`).join("\n")} ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await writeFile(path, pdf);
  return pdf;
}

export interface Fixture {
  root: string;
  db: Library;
  projectId: string;
  collectionId: string;
  store: GenealogyStore;
  events: AppEvent[];
  add(work: Partial<Work>, options?: { pdfPages?: string[] }): Promise<Work>;
  engine(deps?: Partial<EngineDeps>, clients?: ConstructorParameters<typeof GenealogyAI>[1]): GenealogyEngine;
  settings(patch?: Partial<GenealogySettings>): GenealogySettings;
  close(): Promise<void>;
}

export async function genealogyFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-genealogy-"));
  const db = new Library(join(root, "library"));
  const projectId = db.projects()[0].id;
  const collectionId = db.createCollection(projectId, "계보 컬렉션").id;
  const store = new GenealogyStore(db);
  const events: AppEvent[] = [];
  return {
    root,
    db,
    projectId,
    collectionId,
    store,
    events,
    async add(input, options) {
      const work = db.upsert(blankWork({ source: "openalex", ...input })).work;
      db.mutate(projectId, [work.id], { screening: "included" });
      db.db.prepare("INSERT OR IGNORE INTO collection_works VALUES(?,?)").run(collectionId, work.id);
      if (options?.pdfPages) {
        const path = join(root, `${work.id}.pdf`);
        const pdf = await makePdf(path, options.pdfPages);
        db.saveAttachment({ id: `pdf-${work.id}`, workId: work.id, hash: await hashFile(path), path, name: "paper.pdf", mode: "linked", exists: true, size: Buffer.byteLength(pdf), status: "extracted" });
      }
      return db.get(work.id);
    },
    engine(deps = {}, clients = {}) {
      return new GenealogyEngine({
        db,
        store,
        ai: new GenealogyAI(db, clients),
        oa: { page: async (): Promise<Page> => ({ works: [], cursor: null, total: 0, cached: false, fetchedAt: new Date().toISOString() }) } as never,
        downloads: { active: new Map(), sciHub: () => ({ enabled: false, mirrors: [] }) } as never,
        workerPath: WORKER,
        emit: (event) => events.push(event),
        pubmedKey: () => undefined,
        shelfWritable: async () => true,
        busy: () => false,
        fetcher: async () => new Response("not found", { status: 404 }),
        ...deps,
      });
    },
    settings(patch = {}) {
      return { ...defaultGenealogySettings({ ...DEFAULT_AI, aiProvider: "codex" }, "How did the question arise?"), fetchPdfs: false, ...patch };
    },
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Waits for the engine's job to leave the running state. */
export async function settle(engine: GenealogyEngine, id: string, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (engine.active.has(id)) {
    if (Date.now() > deadline) throw new Error("genealogy job did not finish");
    await Bun.sleep(20);
  }
  return engine.store.get(id);
}
