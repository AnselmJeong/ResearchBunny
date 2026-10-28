import { test, expect } from "bun:test";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Service } from "../../src/service/service";
import { DEFAULT_AI } from "../../src/service/providers/openai";
import { loadTaxonomy, readDecisions, tally, taxonomyWith, writeIndex } from "../../src/service/shelf/sorter";
import { folderId } from "../../src/service/shelf/scanner";
import { AppError, type Run } from "../../src/shared/types";
import type { ShelfSortItem } from "../../src/shared/shelf";
import type { Page } from "../../src/service/providers/openalex";
import { fakeOllama, pdf } from "./shelf-helpers";

const worker = resolve("dist/runtime/pdf-worker.cjs");
const MEMORY = "01 Brain/Memory", PAIN = "01 Brain/Pain", SLEEP = "02 Mind/Sleep";
const KIM = `${MEMORY}/2023 - Kim - Hippocampal dopamine supports memory consolidation.pdf`;
const LEE = `${MEMORY}/2022 - Lee - Hippocampal replay and memory.pdf`;
const INBOX = {
  ahn: "2026 - Ahn - Hippocampal memory replay during navigation.pdf",
  baek: "2026 - Baek - Chronic pain nociception in spinal circuits.pdf",
  choi: "2026 - Choi - Hippocampal memory consolidation during sleep.pdf",
  dong: "2026 - Dong - A gardening note on quantum soil.pdf",
  eun: "_uncategorized/2025 - Eun - Pottery glaze chemistry notes.pdf",
  copy: "2023 - Kim - Hippocampal dopamine supports memory consolidation (1).pdf",
  version: "2023 - Kim - Hippocampal dopamine supports memory consolidation.pdf",
  leeAgain: "2022 - Lee - Hippocampal replay and memory.pdf",
};
const TAXONOMY = {
  version: 2,
  policy: { primary_rule: "Assign the single leaf that best matches the paper's PRIMARY subject." },
  domains: [
    { id: "01", name: "01 Brain", leaves: [
      { name: "Memory", def: "Hippocampal memory systems.", incl: ["replay", "consolidation"], excl: ["sleep physiology -> Sleep"], ex: [] },
      { name: "Pain", def: "Pain and nociception.", incl: ["nociceptive circuits"], excl: [], ex: [] },
      { name: "../escape", def: "Never a destination." },
    ] },
    { id: "02", name: "02 Mind", leaves: [{ name: "Sleep", def: "Sleep and circadian rhythms." }] },
  ],
};

async function buildShelf(dir: string, system = true) {
  await pdf(join(dir, KIM), ["Hippocampal dopamine supports memory consolidation", "Min Kim", "Hippocampal dopamine release supports memory consolidation and replay in mice."]);
  await pdf(join(dir, LEE), ["Hippocampal replay and memory", "J Lee", "Hippocampal replay during rest strengthens memory traces."]);
  await pdf(join(dir, PAIN, "2021 - Cho - Nociceptive circuits in chronic pain.pdf"), ["Nociceptive circuits in chronic pain", "Spinal nociceptive circuits drive chronic pain hypersensitivity."]);
  await pdf(join(dir, PAIN, "2020 - Han - Spinal pain pathways and nociception.pdf"), ["Spinal pain pathways and nociception", "Dorsal horn pain pathways shape nociception."]);
  await pdf(join(dir, SLEEP, "2019 - Park - Sleep spindles and circadian rhythms.pdf"), ["Sleep spindles and circadian rhythms", "Thalamic sleep spindles follow circadian rhythms across the night."]);
  await pdf(join(dir, INBOX.ahn), ["Hippocampal memory replay during navigation", "Hippocampal replay supports memory during navigation in rats."]);
  await pdf(join(dir, INBOX.baek), ["Chronic pain nociception in spinal circuits", "Spinal nociceptive circuits in chronic pain patients."]);
  await pdf(join(dir, INBOX.choi), ["Hippocampal memory consolidation during sleep", "Hippocampal memory consolidation and replay depend on sleep."]);
  await pdf(join(dir, INBOX.dong), ["A gardening note on quantum soil", "Quantum soil gardening for tomatoes."]);
  await pdf(join(dir, INBOX.eun), ["Pottery glaze chemistry notes", "Glaze chemistry for pottery kilns."]);
  await copyFile(join(dir, KIM), join(dir, INBOX.copy));
  // Another version: same title, clearly larger. A near-identical re-download: same title, size within 2%.
  await pdf(join(dir, INBOX.version), ["Hippocampal dopamine supports memory consolidation", "Min Kim", "Accepted manuscript with supplementary discussion of dopamine release,", "replay, consolidation, behavioural controls and extended methods."]);
  await pdf(join(dir, INBOX.leeAgain), ["Hippocampal replay and memory", "J Lee", "Hippocampal replay during rest strengthens memory trace."]);
  if (!system) return;
  await mkdir(join(dir, "_system"), { recursive: true });
  await writeFile(join(dir, "_system", "taxonomy.json"), JSON.stringify(TAXONOMY));
}

type Payload = {
  leaves: { leaf: number; path: string; def?: string }[];
  rules: { leaf: number; include: string[]; exclude: string[] }[];
  papers: { paper: number; title: string; text: string; candidates: { leaf: number; share: number }[] }[];
};
/** Keyword "AI": sleep beats memory, so the hippocampal sleep paper disagrees with its neighbours. */
function decide(data: Payload) {
  return {
    decisions: data.papers.map((p) => {
      const text = `${p.title} ${p.text}`.toLowerCase();
      const path = /sleep|spindle/.test(text) ? SLEEP : /pain|nocicept/.test(text) ? PAIN : /hippocamp|memory/.test(text) ? MEMORY : null;
      const leaf = path ? data.leaves.find((l) => l.path === path)!.leaf : null;
      return { paper: p.paper, leaf, confidence: leaf ? "high" : "low", reason: leaf ? "주제가 분명합니다." : "맞는 폴더가 없습니다." };
    }),
  };
}

async function fixture(fn: (ctx: { service: Service; dir: string; calls: { data: Payload; bytes: number }[] }) => Promise<void>, system = true) {
  const root = await mkdtemp(join(tmpdir(), "rb-sort-"));
  const dir = join(root, "Articles");
  await buildShelf(dir, system);
  const service = new Service(join(root, "library"), worker, () => {});
  const ollama = fakeOllama();
  const empty = (): Page => ({ works: [], cursor: null, total: 0, cached: false, fetchedAt: new Date().toISOString() });
  service.oa.page = async (_params: Record<string, string>, _signal: AbortSignal, onCall: () => void) => { onCall(); return empty(); };
  service.oa.lookup = async () => { throw new Error("not found"); };
  const calls: { data: Payload; bytes: number }[] = [];
  service.ai.structured = async (_run: Run, _name: string, schema: Record<string, unknown>, instruction: string, data: unknown) => {
    calls.push({ data: data as Payload, bytes: Buffer.byteLength(JSON.stringify(data) + instruction + JSON.stringify(schema)) + 2000 });
    return decide(data as Payload);
  };
  service.db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: true, aiMaxInputTokens: 100000 });
  try {
    await service.call("shelfConfigure", { path: dir, ollamaUrl: ollama.url });
    await service.shelf.wait();
    await fn({ service, dir, calls });
  } finally {
    service.shelf.stop();
    await service.shelf.wait();
    service.downloads.stopRecoveryMonitor();
    ollama.stop();
    service.db.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function propose(service: Service, uncategorized = false) {
  service.sorter.start({ uncategorized });
  for (let i = 0; i < 4000 && service.sorter.active; i++) await Bun.sleep(5);
  expect(service.sorter.active).toBeNull();
  return service.sorter.state();
}
const byPath = (items: ShelfSortItem[], rel: string) => items.find((i) => i.relPath === rel)!;
const row = (service: Service, rel: string) =>
  (service.db.db.prepare("SELECT * FROM shelf_files WHERE rel_path=?").get(rel) ?? undefined) as { id: string; work_id: string; folder_id: string; stage: string; mtime: number; hashed_mtime: number; attachment_id: string | null } | undefined;

test("votes, decisions and taxonomy parsing", async () => {
  const votes = tally([{ path: "a", score: 0.9 }, { path: "b", score: 0.8 }, { path: "b", score: 0.79 }, { path: "a", score: 0.6 }]);
  expect(votes.map((v) => v.path)).toEqual(["a", "b"]);
  expect(votes[0].share).toBeGreaterThan(0.6);
  expect(votes[0].similarity).toBe(0.9);
  expect(votes.reduce((sum, v) => sum + v.share, 0)).toBeCloseTo(1, 2);
  expect(tally([])).toEqual([]);
  // A folder with a negligible share is dropped; the top folder always stays.
  expect(tally([{ path: "a", score: 0.9 }, { path: "c", score: 0.7 }]).map((v) => v.path)).toEqual(["a"]);

  const decisions = readDecisions({ decisions: [
    { paper: 0, leaf: 2, confidence: "high", reason: "a" },
    { paper: 0, leaf: 1, confidence: "high", reason: "repeat" },
    { paper: 1, leaf: 9, confidence: "high", reason: "no such leaf" },
    { paper: 2, leaf: null, confidence: "low", reason: "none fits" },
    { paper: 7, leaf: 1, confidence: "high", reason: "no such paper" },
  ] }, 3, 3);
  expect([...decisions.keys()]).toEqual([0, 2]);
  expect(decisions.get(0)!.leaf).toBe(2);
  expect(() => readDecisions({ decisions: [{ paper: 0, leaf: "x" }] }, 1, 3)).toThrow(AppError);

  const root = await mkdtemp(join(tmpdir(), "rb-taxonomy-"));
  try {
    await mkdir(join(root, "_system"));
    await writeFile(join(root, "_system", "taxonomy.json"), JSON.stringify(TAXONOMY));
    const file = await loadTaxonomy(root, []);
    expect(file.source).toBe("file");
    expect(file.leaves.map((l) => l.path)).toEqual([MEMORY, PAIN, SLEEP]);
    expect(file.leaves[0]).toMatchObject({ domain: "01 Brain", name: "Memory", incl: ["replay", "consolidation"] });
    const folders = await loadTaxonomy(join(root, "missing"), ["", "A", "A/X", "A/Y", "B", "_uncategorized", "_misc/Z", ".hidden"]);
    expect(folders.source).toBe("folders");
    expect(folders.leaves.map((l) => l.path)).toEqual(["A/X", "A/Y", "B"]);
    await writeFile(join(root, "_system", "taxonomy.json"), "{ not json");
    await expect(loadTaxonomy(root, [])).rejects.toThrow(AppError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("index.json matches intake.py reindex: categories by folder, root PDFs and system folders left out", async () => {
  const root = await mkdtemp(join(tmpdir(), "rb-index-"));
  try {
    for (const rel of ["A/X/b.pdf", "A/X/a.pdf", "A/notes.txt", "_uncategorized/u.pdf", "_system/tool.pdf", "_news/n.pdf", "_summaries/s.pdf", ".hidden/h.pdf", "root.pdf", "A/X/.dot.pdf"]) {
      await mkdir(join(root, rel, ".."), { recursive: true });
      await writeFile(join(root, rel), "x");
    }
    await writeIndex(root);
    const index = JSON.parse(await readFile(join(root, "index.json"), "utf8"));
    expect(index.version).toBe(2);
    expect(index.generated).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    expect(index.categories).toEqual({ "A/X": ["a.pdf", "b.pdf"], _uncategorized: ["u.pdf"] });
    expect(index.files).toEqual({ "a.pdf": { category: "A/X" }, "b.pdf": { category: "A/X" }, "u.pdf": { category: "_uncategorized" } });
    expect(await readFile(join(root, "index.json"), "utf8")).toStartWith('{\n "version": 2,\n "generated": ');
    expect((await readdir(root)).filter((name) => name.includes("researchbunny"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inbox proposals combine neighbour votes, AI decisions and duplicate rules, and approved moves keep the index", async () => fixture(async ({ service, dir, calls }) => {
  const before = await readdir(dir);
  const state = await propose(service);
  expect(state.job.status).toBe("ready");
  expect(state.taxonomy).toBe("file");
  expect(state.ledger).toBe(true);
  expect(state.leaves.map((l) => l.path)).toEqual([MEMORY, PAIN, SLEEP]);
  expect(state.waiting).toEqual([]);
  // Proposing never touches the shelf.
  expect(await readdir(dir)).toEqual(before);

  // The inbox is the shelf root: what an earlier run parked in _uncategorized is not proposed again.
  const items = state.items;
  expect(items).toHaveLength(7);
  expect(items.find((i) => i.relPath === INBOX.eun)).toBeUndefined();
  expect(byPath(items, INBOX.ahn)).toMatchObject({ target: MEMORY, source: "ai", confidence: "high", agree: true });
  expect(byPath(items, INBOX.ahn).votes[0].path).toBe(MEMORY);
  expect(byPath(items, INBOX.baek)).toMatchObject({ target: PAIN, source: "ai", agree: true });
  expect(byPath(items, INBOX.choi)).toMatchObject({ target: SLEEP, source: "ai", agree: false });
  expect(byPath(items, INBOX.choi).votes[0].path).toBe(MEMORY);
  expect(byPath(items, INBOX.dong)).toMatchObject({ target: "_uncategorized", confidence: "low", agree: null });
  expect(byPath(items, INBOX.copy)).toMatchObject({ target: "_duplicated", source: "duplicate", existing: KIM, reason: "같은 파일이 이미 서고에 있습니다." });
  expect(byPath(items, INBOX.leeAgain)).toMatchObject({ target: "_duplicated", source: "duplicate", existing: LEE });
  expect(byPath(items, INBOX.version)).toMatchObject({ target: MEMORY, source: "version", existing: KIM });

  // One AI call: only papers without an existing copy, with candidates and the rules of candidate leaves.
  expect(calls).toHaveLength(1);
  const payload = calls[0].data;
  expect(payload.papers.map((p) => p.title).sort()).toEqual(["A gardening note on quantum soil", "Chronic pain nociception in spinal circuits", "Hippocampal memory consolidation during sleep", "Hippocampal memory replay during navigation"]);
  expect(payload.leaves).toHaveLength(3);
  const ahn = payload.papers.find((p) => p.title.includes("navigation"))!;
  expect(ahn.text).toContain("Hippocampal replay supports memory");
  expect(ahn.candidates[0]).toMatchObject({ leaf: 1 });
  expect(payload.rules.map((r) => r.leaf)).toContain(1);
  expect(payload.rules.every((r) => r.include.length + r.exclude.length > 0)).toBe(true);
  expect(JSON.stringify(payload)).not.toContain(dir);

  const ahnBefore = row(service, INBOX.ahn)!;
  const leeAgain = row(service, INBOX.leeAgain)!;
  // A file changed after the proposal is skipped; a target outside the taxonomy is refused.
  await appendFile(join(dir, INBOX.baek), "\n% edited");
  const approved = items.filter((i) => i.target).map((i) => ({ fileId: i.fileId, target: i.target! }));
  const result = await service.call("shelfSortApply", { items: [{ fileId: byPath(items, INBOX.ahn).fileId, target: "01 Brain/../escape" }, ...approved] });
  await service.shelf.wait();
  expect(result).toMatchObject({ moved: 3, uncategorized: 1, duplicated: 2 });
  expect(result.skipped.map((s: { reason: string }) => s.reason)).toEqual(["분류 기준에 없는 폴더입니다.", "파일이 바뀌었습니다. 제안을 다시 만드세요."]);

  // Files moved with their names; a taken name gets " (2)" as intake.py does.
  const moved = [`${MEMORY}/${INBOX.ahn}`, `${SLEEP}/${INBOX.choi}`, `_uncategorized/${INBOX.dong}`, `_duplicated/${INBOX.copy}`, `_duplicated/${INBOX.leeAgain}`,
    `${MEMORY}/2023 - Kim - Hippocampal dopamine supports memory consolidation (2).pdf`];
  for (const rel of moved) expect((await stat(join(dir, rel))).isFile()).toBe(true);
  expect((await readdir(dir)).filter((name) => name.endsWith(".pdf"))).toEqual([INBOX.baek]);

  // The ledger intake.py keeps: move_log.jsonl, logs/intake-<date>.md and a rebuilt index.json.
  const log = (await readFile(join(dir, "_system", "move_log.jsonl"), "utf8")).trim().split("\n");
  expect(log).toHaveLength(6);
  expect(log[0]).toStartWith('{"id": -100, "src": ');
  expect(log.map((line) => JSON.parse(line).by)).toEqual(Array(6).fill("ResearchBunny"));
  const [logName] = await readdir(join(dir, "_system", "logs"));
  const runLog = await readFile(join(dir, "_system", "logs", logName), "utf8");
  expect(logName).toMatch(/^intake-\d{4}-\d\d-\d\d\.md$/);
  expect(runLog).toMatch(/\n## run \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d · ResearchBunny\n/);
  expect(runLog).toContain(`- ${MEMORY}/${INBOX.ahn}\n`);
  expect(runLog).toContain(`- (uncategorized) _duplicated/${INBOX.copy}\n`);
  const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  expect(index.categories[MEMORY]).toContain(INBOX.ahn);
  expect(index.categories._duplicated.sort()).toEqual([INBOX.copy, INBOX.leeAgain].sort());
  expect(index.files[INBOX.dong]).toEqual({ category: "_uncategorized" });

  // The index follows without re-reading: same row, folder, attachment; duplicates leave the shelf.
  const ahnAfter = row(service, `${MEMORY}/${INBOX.ahn}`)!;
  expect(ahnAfter.id).toBe(ahnBefore.id);
  expect(ahnAfter.stage).toBe("resolved");
  expect(ahnAfter.hashed_mtime).toBe(ahnAfter.mtime);
  expect(ahnAfter.folder_id).toBe(folderId(service.shelf.root()!.id, MEMORY));
  expect(service.db.attachments(ahnAfter.work_id).find((a) => a.id === ahnAfter.attachment_id)?.path).toBe(join(dir, MEMORY, INBOX.ahn));
  expect(row(service, `_duplicated/${INBOX.copy}`)).toBeUndefined();
  expect(service.db.db.prepare("SELECT 1 FROM works WHERE id=?").get(leeAgain.work_id)).toBeNull();
  expect((service.db.db.prepare("SELECT count(*) AS n FROM shelf_files WHERE status='missing'").get() as { n: number }).n).toBe(0);
  // Papers moved to _uncategorized leave the inbox and are counted apart.
  const summary = service.shelf.summary();
  expect(summary.inbox).toBe(1);
  expect(summary.uncategorized).toEqual({ id: folderId(service.shelf.root()!.id, "_uncategorized"), count: 2 });
  expect(summary.folders.some((f) => f.relPath.startsWith("_uncategorized"))).toBe(false);
  expect(service.db.shelfScope("inbox")).toEqual([row(service, INBOX.baek)!.work_id]);
  expect(summary.folders.find((f) => f.relPath === MEMORY)!.count).toBe(4);
  // Applied items leave the saved proposal; the skipped one stays, and the job describes it, not the past move.
  expect(result.ledger).toBe(true);
  const left = service.sorter.view();
  expect(left.items.map((i) => i.relPath)).toEqual([INBOX.baek]);
  expect(left.job.message).toBe("남은 제안 1편 · 옮길 논문 1편");
  // It still covers the whole inbox and has a move left, so reopening the window resumes it.
  expect(left).toMatchObject({ inbox: 1, uncategorized: 2, fresh: 0, current: true });
  // A PDF that arrives afterwards makes it stale: reopening starts from today's inbox instead.
  const GIL = "2026 - Gil - Hippocampal theta and memory.pdf";
  await pdf(join(dir, GIL), ["Hippocampal theta and memory", "Theta rhythms organise hippocampal memory."]);
  await service.shelf.scan("test");
  await service.shelf.wait();
  expect(service.sorter.view()).toMatchObject({ inbox: 2, fresh: 1, current: false });

  // Moving the last item finishes the proposal, so the next visit starts from today's inbox.
  await service.call("shelfSortApply", { items: [{ fileId: byPath(items, INBOX.baek).fileId, target: PAIN }] });
  await service.shelf.wait();
  const finished = service.sorter.view();
  expect(finished).toMatchObject({ createdAt: null, items: [], waiting: [], job: { status: "idle", message: "" }, inbox: 1, fresh: 1, current: false });

  // A proposal saved before 0.3.3 kept no list of what it saw, so it never comes back on reopening.
  service.db.pref("shelf:sort", { ...left, job: { status: "ready", message: "89편을 옮겼습니다.", updatedAt: left.job.updatedAt }, covered: undefined });
  expect(service.sorter.view()).toMatchObject({ inbox: 1, fresh: 1, current: false });

  // Until asked for, _uncategorized stays out of proposals and its papers count as existing copies.
  const EUN_COPY = "2025 - Eun - Pottery glaze chemistry notes (1).pdf";
  await copyFile(join(dir, INBOX.eun), join(dir, EUN_COPY));
  await service.shelf.scan("test");
  await service.shelf.wait();
  calls.length = 0;
  const plain = await propose(service);
  expect(plain.items.map((i) => i.relPath).sort()).toEqual([EUN_COPY, GIL].sort());
  expect(byPath(plain.items, EUN_COPY)).toMatchObject({ target: "_duplicated", source: "duplicate", existing: INBOX.eun });
  expect(calls.flatMap((c) => c.data.papers.map((p) => p.title))).toEqual(["Hippocampal theta and memory"]);
  await service.call("shelfSortApply", { items: [{ fileId: byPath(plain.items, EUN_COPY).fileId, target: "_duplicated" }] });
  await service.shelf.wait();

  // Asked for, _uncategorized is judged again. Papers that would stay put are not a move:
  // once the only move is made, the proposal is finished.
  calls.length = 0;
  const wide = await propose(service, true);
  expect(wide.items.map((i) => i.relPath).sort()).toEqual([GIL, INBOX.eun, `_uncategorized/${INBOX.dong}`].sort());
  expect(byPath(wide.items, INBOX.eun)).toMatchObject({ folder: "_uncategorized", target: "_uncategorized", confidence: "low" });
  expect(byPath(wide.items, GIL)).toMatchObject({ target: MEMORY });
  expect(calls[0].data.papers).toHaveLength(3);
  expect(service.sorter.view()).toMatchObject({ inbox: 1, uncategorized: 2, fresh: 0, current: true });
  await service.call("shelfSortApply", { items: [{ fileId: byPath(wide.items, GIL).fileId, target: MEMORY }] });
  await service.shelf.wait();
  expect(service.sorter.view()).toMatchObject({ createdAt: null, items: [], inbox: 0, uncategorized: 2, current: false });
}));

test("without _system or a working AI: folder leaves, no ledger, vote fallback and budget-sized batches", async () => fixture(async ({ service, dir, calls }) => {
  service.db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: false });
  expect(() => service.sorter.start()).toThrow(/AI/);

  service.db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: true, aiMaxInputTokens: 100000 });
  const real = service.ai.structured;
  service.ai.structured = async () => { throw new AppError("CODEX_PROVIDER", "사용 한도에 도달했습니다."); };
  const failed = await propose(service);
  expect(failed.taxonomy).toBe("folders");
  expect(failed.ledger).toBe(false);
  expect(failed.leaves.map((l) => l.path)).toEqual([MEMORY, PAIN, SLEEP]);
  expect(failed.job.message).toContain("AI 판정 실패 4편");
  expect(byPath(failed.items, INBOX.ahn)).toMatchObject({ source: "embedding", target: MEMORY, reason: "AI 판정 실패: 사용 한도에 도달했습니다." });

  // A small input budget splits the inbox into several calls, each within the limit.
  service.ai.structured = real;
  await propose(service);
  const papers = calls[0].data.papers.map((p) => Buffer.byteLength(JSON.stringify(p)) + 1);
  const limit = calls[0].bytes - papers.reduce((a, b) => a + b, 0) + 2 * Math.max(...papers);
  calls.length = 0;
  service.db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: true, aiMaxInputTokens: limit });
  const split = await propose(service);
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every((c) => c.bytes <= limit)).toBe(true);
  expect(calls.reduce((sum, c) => sum + c.data.papers.length, 0)).toBe(4);
  expect(byPath(split.items, INBOX.choi)).toMatchObject({ target: SLEEP, source: "ai" });
  service.db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: true, aiMaxInputTokens: 3000 });
  expect((await propose(service)).job).toMatchObject({ status: "failed", message: expect.stringContaining("AI 입력 상한") });

  service.db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: true, aiMaxInputTokens: 100000 });
  const state = await propose(service);
  await service.call("shelfSortApply", { items: [{ fileId: byPath(state.items, INBOX.ahn).fileId, target: MEMORY }] });
  await service.shelf.wait();
  expect((await stat(join(dir, MEMORY, INBOX.ahn))).isFile()).toBe(true);
  expect(await readdir(dir)).not.toContain("_system");
  expect(await readdir(dir)).not.toContain("index.json");
}, false));

/** `intake.py addleaf`'s own code (cmd_addleaf), run on a copy to compare the bytes it writes. */
const ADDLEAF = `import json, sys
TAX, dom_id, name, definition = sys.argv[1:5]
tax = json.load(open(TAX, encoding="utf-8"))
for d in tax["domains"]:
    if d["id"] == dom_id or d["name"] == dom_id:
        if any(l["name"] == name for l in d["leaves"]):
            print("EXISTS"); sys.exit()
        d["leaves"].append({"name": name, "def": definition, "incl": [], "excl": [], "ex": []})
        d["leaves"].sort(key=lambda l: l["name"])
        json.dump(tax, open(TAX, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("ADDED"); sys.exit()
print("NO_SUCH_DOMAIN")
`;
const KO = "_uncategorized/2024 - Ko - Ceramic kiln firing schedules.pdf";
const MOON = "_uncategorized/2023 - Moon - Hippocampal place cells in bats.pdf";
async function parkMore(service: Service, dir: string) {
  await pdf(join(dir, KO), ["Ceramic kiln firing schedules", "Kiln firing schedules for stoneware glazes."]);
  await pdf(join(dir, MOON), ["Hippocampal place cells in bats", "Hippocampal place cells map three-dimensional space in flying bats."]);
  await service.shelf.scan("test");
  await service.shelf.wait();
}
const workOf = (service: Service, rel: string) => row(service, rel)!.work_id;
async function fileInto(service: Service, input: Record<string, unknown>) {
  const result = await service.call("shelfFileInto", input);
  await service.shelf.wait();
  return result as { moved: number; skipped: { relPath: string; reason: string }[]; created?: string[]; ledger: boolean };
}
async function refused(service: Service, input: Record<string, unknown>, message: RegExp) {
  await expect(service.call("shelfFileInto", input)).rejects.toThrow(message);
  await service.shelf.wait();
}

test("filing 미분류 by hand: an existing leaf, a new leaf in a taxonomy.json written as addleaf writes it, and the index follows", async () => fixture(async ({ service, dir }) => {
  await parkMore(service, dir);
  const taxonomyPath = join(dir, "_system", "taxonomy.json");
  const original = await readFile(taxonomyPath, "utf8");

  // The picker lists every domain and leaf; the unsafe "../escape" is never a destination.
  const list = await service.call("shelfLeaves", {});
  expect(list.taxonomy).toBe("file");
  expect(list.domains.map((d: { name: string }) => d.name)).toEqual(["01 Brain", "02 Mind"]);
  expect(list.domains[0].leaves).toEqual([
    { path: MEMORY, domain: "01 Brain", name: "Memory", def: "Hippocampal memory systems.", missing: false },
    { path: PAIN, domain: "01 Brain", name: "Pain", def: "Pain and nociception.", missing: false },
  ]);

  // An existing leaf: no AI call, the row keeps its work, hash stamp and attachment at the new path.
  const before = row(service, MOON)!;
  const filed = await fileInto(service, { workIds: [before.work_id], target: MEMORY });
  expect(filed).toMatchObject({ moved: 1, skipped: [], ledger: true });
  expect(filed.created).toBeUndefined();
  const moonRel = `${MEMORY}/2023 - Moon - Hippocampal place cells in bats.pdf`;
  expect((await stat(join(dir, moonRel))).isFile()).toBe(true);
  const after = row(service, moonRel)!;
  expect(after).toMatchObject({ id: before.id, work_id: before.work_id, stage: "resolved", folder_id: folderId(service.shelf.root()!.id, MEMORY) });
  expect(after.hashed_mtime).toBe(after.mtime);
  expect(service.db.attachments(after.work_id).find((a) => a.id === after.attachment_id)?.path).toBe(join(dir, moonRel));
  expect(service.db.shelfScope(folderId(service.shelf.root()!.id, "_uncategorized"))).not.toContain(before.work_id);
  const log = (await readFile(join(dir, "_system", "move_log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(log).toEqual([expect.objectContaining({ src: MOON, dst: moonRel, st: "moving", by: "ResearchBunny" })]);
  expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8")).files["2023 - Moon - Hippocampal place cells in bats.pdf"]).toEqual({ category: MEMORY });
  // Filing into a leaf never touches the taxonomy.
  expect(await readFile(taxonomyPath, "utf8")).toBe(original);

  // Names a NAS share, intake.py or the taxonomy would trip over are refused before anything is made.
  const eun = workOf(service, INBOX.eun);
  const brain = (await readdir(join(dir, "01 Brain"))).sort();
  for (const [name, message] of [
    ["", /폴더 이름을 입력하세요/], ["Sleep/Wake", /\/ 나 \\/], ["Sleep\\Wake", /\/ 나 \\/], [".cache", /\. 이나 _ 로 시작/], ["_misc", /\. 이나 _ 로 시작/],
    ["Glaze: notes", /: \*/], ["Glazes.", /\. 으로 끝날/], [" Glazes", /앞뒤의 공백/], ["memory", /같은 이름의 폴더/], ["Pain", /같은 이름의 폴더/],
  ] as const) await refused(service, { workIds: [eun], create: { domain: "01 Brain", name, def: "" } }, message);
  await refused(service, { workIds: [eun], create: { domain: "03 Nope", name: "Glazes", def: "" } }, /taxonomy.json에 없는 도메인/);
  await expect(service.call("shelfFileInto", { workIds: [eun] })).rejects.toThrow();
  await expect(service.call("shelfFileInto", { workIds: [eun], target: MEMORY, create: { domain: "01 Brain", name: "Glazes", def: "" } })).rejects.toThrow();
  expect((await readdir(join(dir, "01 Brain"))).sort()).toEqual(brain);
  expect(await readFile(taxonomyPath, "utf8")).toBe(original);
  expect((await stat(join(dir, INBOX.eun))).isFile()).toBe(true);

  // Only 미분류 papers move, only into taxonomy leaves; a new folder is not made for papers that cannot go.
  const ahn = workOf(service, INBOX.ahn), kim = workOf(service, KIM);
  const outside = await fileInto(service, { workIds: [ahn, kim], create: { domain: "01 Brain", name: "Navigation", def: "" } });
  expect(outside).toMatchObject({ moved: 0, ledger: false });
  expect(outside.skipped).toEqual([{ relPath: INBOX.ahn, reason: "미분류에 없는 논문입니다." }, { relPath: KIM, reason: "미분류에 없는 논문입니다." }]);
  expect((await readdir(join(dir, "01 Brain"))).sort()).toEqual(brain);
  for (const target of ["_duplicated", "_uncategorized", "01 Brain/../escape", "01 Brain"])
    expect((await fileInto(service, { workIds: [eun], target })).skipped).toEqual([{ relPath: INBOX.eun, reason: "분류 기준에 없는 폴더입니다." }]);
  expect((await stat(join(dir, INBOX.eun))).isFile()).toBe(true);

  // A new leaf. This taxonomy.json is not kept one leaf per line, so it is written byte for byte as intake.py addleaf writes it.
  const expected = join(dir, "..", "addleaf.json");
  await writeFile(expected, original);
  const def = "Pottery, glaze chemistry and kilns (도자기).";
  const python = Bun.which("python3");
  if (python) expect(Bun.spawnSync([python, "-I", "-c", ADDLEAF, expected, "02 Mind", "Ceramics & Glazes", def]).stdout.toString().trim()).toBe("ADDED");
  const ko = row(service, KO)!;
  const made = await fileInto(service, { workIds: [eun, ko.work_id], create: { domain: "02 Mind", name: "Ceramics & Glazes", def: "  Pottery, glaze chemistry\n and kilns (도자기). " } });
  const CERAMICS = "02 Mind/Ceramics & Glazes";
  expect(made).toMatchObject({ moved: 2, skipped: [], created: [CERAMICS], ledger: true });
  const written = await readFile(taxonomyPath, "utf8");
  if (python) expect(written).toBe(await readFile(expected, "utf8"));
  expect(written).toStartWith('{\n "version": 2,\n "policy": {\n  "primary_rule": ');
  expect(written).toContain("(도자기)");
  const mind = JSON.parse(written).domains[1];
  expect(mind.leaves).toEqual([{ name: "Ceramics & Glazes", def, incl: [], excl: [], ex: [] }, { name: "Sleep", def: "Sleep and circadian rhythms." }]);
  expect(JSON.parse(written).domains[0]).toEqual(TAXONOMY.domains[0]);
  expect((await readdir(join(dir, "_system"))).filter((name) => name.includes("researchbunny"))).toEqual([]);
  expect((await loadTaxonomy(dir, [])).leaves.map((l) => l.path)).toEqual([MEMORY, PAIN, CERAMICS, SLEEP]);
  // Both papers moved with their rows; the ledger records the new leaf and the run.
  for (const [rel, id] of [[`${CERAMICS}/2025 - Eun - Pottery glaze chemistry notes.pdf`, row(service, `${CERAMICS}/2025 - Eun - Pottery glaze chemistry notes.pdf`)?.id], [`${CERAMICS}/2024 - Ko - Ceramic kiln firing schedules.pdf`, ko.id]] as const) {
    expect((await stat(join(dir, rel))).isFile()).toBe(true);
    expect(row(service, rel)?.id).toBe(id!);
  }
  const [logName] = await readdir(join(dir, "_system", "logs"));
  const runLog = await readFile(join(dir, "_system", "logs", logName), "utf8");
  expect(runLog).toContain(`\n## addleaf `);
  expect(runLog).toContain(`- ${CERAMICS} — ${def}\n`);
  expect(runLog).toContain(`- ${CERAMICS}/2024 - Ko - Ceramic kiln firing schedules.pdf\n`);
  expect(JSON.parse(await readFile(join(dir, "index.json"), "utf8")).categories[CERAMICS]).toEqual(["2024 - Ko - Ceramic kiln firing schedules.pdf", "2025 - Eun - Pottery glaze chemistry notes.pdf"]);
  // 미분류 is empty now, so the sidebar entry goes.
  expect(service.shelf.summary().uncategorized).toBeNull();
  // The new leaf is a destination now and counts as a taken name.
  expect((await service.call("shelfLeaves", {})).domains[1].leaves.map((l: { name: string }) => l.name)).toEqual(["Ceramics & Glazes", "Sleep"]);

  // A folder made by hand joins the taxonomy as it is; one that differs only in case is refused.
  await mkdir(join(dir, "01 Brain", "Vision"));
  await mkdir(join(dir, "01 Brain", "attention"));
  await pdf(join(dir, "_uncategorized/2022 - Oh - Visual cortex orientation maps.pdf"), ["Visual cortex orientation maps", "Orientation maps in primary visual cortex."]);
  await service.shelf.scan("test");
  await service.shelf.wait();
  const oh = workOf(service, "_uncategorized/2022 - Oh - Visual cortex orientation maps.pdf");
  await refused(service, { workIds: [oh], create: { domain: "02 Mind", name: "ceramics & glazes", def: "" } }, /같은 이름의 폴더/);
  await refused(service, { workIds: [oh], create: { domain: "01 Brain", name: "Attention", def: "" } }, /대소문자만 다른 폴더\(attention\)/);
  expect(await fileInto(service, { workIds: [oh], create: { domain: "01 Brain", name: "Vision", def: "" } })).toMatchObject({ moved: 1, created: ["01 Brain/Vision"] });
  expect(JSON.parse(await readFile(taxonomyPath, "utf8")).domains[0].leaves.map((l: { name: string }) => l.name)).toEqual(["../escape", "Memory", "Pain", "Vision"]);
}));

test("a leaf renamed or removed by hand is never recreated; the sort window can send a paper to a new leaf", async () => fixture(async ({ service, dir }) => {
  await parkMore(service, dir);
  const { rename: move } = await import("node:fs/promises");
  await move(join(dir, SLEEP), join(dir, "02 Mind", "Sleep & Circadian"));
  await service.shelf.scan("test");
  await service.shelf.wait();
  const gone = "폴더가 서고에 없습니다. 손으로 이름을 바꿨거나 지웠다면 _system/taxonomy.json도 고치세요.";

  // The picker shows the leaf as missing, and neither path recreates it.
  expect((await service.call("shelfLeaves", {})).domains[1].leaves).toEqual([{ path: SLEEP, domain: "02 Mind", name: "Sleep", def: "Sleep and circadian rhythms.", missing: true }]);
  expect((await fileInto(service, { workIds: [workOf(service, KO)], target: SLEEP })).skipped).toEqual([{ relPath: KO, reason: gone }]);
  const choi = row(service, INBOX.choi)!;
  const applied = await service.call("shelfSortApply", { items: [{ fileId: choi.id, target: SLEEP }] });
  await service.shelf.wait();
  expect(applied).toMatchObject({ moved: 0, skipped: [{ relPath: INBOX.choi, reason: gone }] });
  expect(await readdir(join(dir, "02 Mind"))).toEqual(["Sleep & Circadian"]);
  expect((await stat(join(dir, INBOX.choi))).isFile()).toBe(true);

  // A proposal row set to 새 폴더…: the leaf is made when the paper moves, in the same call.
  const PHYSIOLOGY = "02 Mind/Sleep Physiology";
  const created = await service.call("shelfSortApply", {
    items: [{ fileId: choi.id, target: PHYSIOLOGY }, { fileId: row(service, INBOX.baek)!.id, target: PAIN }],
    create: [{ domain: "02 Mind", name: "Sleep Physiology", def: "Sleep stages, spindles and their physiology." }],
  });
  await service.shelf.wait();
  expect(created).toMatchObject({ moved: 2, created: [PHYSIOLOGY], skipped: [] });
  expect(row(service, `${PHYSIOLOGY}/${INBOX.choi}`)?.id).toBe(choi.id);
  expect(JSON.parse(await readFile(join(dir, "_system", "taxonomy.json"), "utf8")).domains[1].leaves.map((l: { name: string }) => l.name)).toEqual(["Sleep", "Sleep Physiology"]);
  // A new leaf is never a way around the rule: a name already in the taxonomy is refused even when its folder is gone.
  await expect(service.call("shelfSortApply", { items: [{ fileId: row(service, INBOX.dong)!.id, target: SLEEP }], create: [{ domain: "02 Mind", name: "Sleep", def: "" }] })).rejects.toThrow(/같은 이름의 폴더/);
  await service.shelf.wait();
  expect((await readdir(join(dir, "02 Mind"))).sort()).toEqual(["Sleep & Circadian", "Sleep Physiology"]);

  // A domain folder renamed by hand is not recreated either.
  await move(join(dir, "01 Brain"), join(dir, "01 Brain (old)"));
  await refused(service, { workIds: [workOf(service, KO)], create: { domain: "01 Brain", name: "Vision", def: "" } }, /도메인 폴더가 서고에 없습니다: 01 Brain/);
  expect(await readdir(dir)).not.toContain("01 Brain");
}));

test("without taxonomy.json a new folder is just a folder, and the AI drafts a definition from the papers", async () => fixture(async ({ service, dir }) => {
  await parkMore(service, dir);
  const list = await service.call("shelfLeaves", {});
  expect(list.taxonomy).toBe("folders");
  expect(list.domains.map((d: { name: string }) => d.name)).toEqual(["01 Brain", "02 Mind"]);
  // The folders on disk are the domain's names.
  await refused(service, { workIds: [workOf(service, KO)], create: { domain: "01 Brain", name: "pain", def: "" } }, /같은 이름의 폴더/);
  await refused(service, { workIds: [workOf(service, KO)], create: { domain: "", name: "Ceramics", def: "" } }, /새 폴더를 둘 수 없는 위치/);
  const made = await fileInto(service, { workIds: [workOf(service, KO)], create: { domain: "02 Mind", name: "Ceramics", def: "ignored without a taxonomy" } });
  expect(made).toMatchObject({ moved: 1, created: ["02 Mind/Ceramics"], ledger: false });
  expect((await stat(join(dir, "02 Mind/Ceramics/2024 - Ko - Ceramic kiln firing schedules.pdf"))).isFile()).toBe(true);
  expect(await readdir(dir)).not.toContain("_system");
  expect(await readdir(dir)).not.toContain("index.json");
  expect((await service.call("shelfLeaves", {})).domains[1].leaves.map((l: { path: string }) => l.path)).toEqual(["02 Mind/Ceramics", SLEEP]);

  // The definition draft sends titles, abstracts and sibling leaves, never paths, and comes back as one line.
  const sent: { name: string; data: { domain: string; name: string; siblings: unknown[]; papers: { title: string; text: string }[] } }[] = [];
  service.ai.structured = async (_run: Run, name: string, _schema: Record<string, unknown>, _instruction: string, data: unknown) => {
    sent.push({ name, data: data as (typeof sent)[number]["data"] });
    return { def: "  Pottery glazes,\n kilns and firing. " };
  };
  const draft = await service.call("shelfLeafDraft", { workIds: [workOf(service, INBOX.eun)], fileIds: [row(service, MOON)!.id], domain: "02 Mind", name: "Glazes" });
  expect(draft).toEqual({ def: "Pottery glazes, kilns and firing." });
  expect(sent).toHaveLength(1);
  expect(sent[0].name).toBe("shelf_leaf_definition");
  expect(sent[0].data).toMatchObject({ domain: "02 Mind", name: "Glazes", siblings: [{ name: "Ceramics" }, { name: "Sleep" }] });
  expect(sent[0].data.papers.map((p) => p.title).sort()).toEqual(["Hippocampal place cells in bats", "Pottery glaze chemistry notes"]);
  expect(sent[0].data.papers.find((p) => p.title.startsWith("Pottery"))!.text).toContain("Glaze chemistry");
  expect(JSON.stringify(sent[0].data)).not.toContain(dir);
  service.db.pref("ai", { ...DEFAULT_AI, aiProvider: "codex", aiEnabled: false });
  await expect(service.call("shelfLeafDraft", { workIds: [workOf(service, INBOX.eun)], domain: "02 Mind", name: "Glazes" })).rejects.toThrow(/AI/);
}, false));

/** The real shelf's layout: one leaf per line, leaves in the curator's order, not by name. */
const HAND_KEPT = `{
  "version": 2,
  "policy": {
    "primary_rule": "Assign the single leaf that best matches the paper's PRIMARY subject."
  },
  "domains": [
    {"id":"01","name":"01 Brain","leaves":[
      {"name":"Pain","def":"Pain and nociception.","incl":["nociceptive circuits"],"excl":[],"ex":[]},
      {"name":"Memory","def":"Hippocampal memory systems.","incl":["replay"],"excl":["sleep physiology -> Sleep"],"ex":[]}
    ]},
    {"id":"02","name":"02 Mind","leaves":[
      {"name":"Sleep","def":"Sleep and circadian rhythms.","incl":[],"excl":[],"ex":[]}
    ]}
  ]
}
`;

test("a taxonomy.json kept one leaf per line keeps every line: a new leaf is one more line at the end of its domain", async () => fixture(async ({ service, dir }) => {
  const taxonomyPath = join(dir, "_system", "taxonomy.json");
  await writeFile(taxonomyPath, HAND_KEPT);
  // From the sort window: two new leaves in two domains, made in the same call that moves the papers.
  const result = await service.call("shelfSortApply", {
    items: [{ fileId: row(service, INBOX.ahn)!.id, target: "01 Brain/Navigation" }, { fileId: row(service, INBOX.dong)!.id, target: "02 Mind/Gardening" }],
    create: [{ domain: "01 Brain", name: "Navigation", def: "Spatial navigation and place cells." }, { domain: "02 Mind", name: "Gardening", def: "" }],
  });
  await service.shelf.wait();
  expect(result).toMatchObject({ moved: 2, created: ["01 Brain/Navigation", "02 Mind/Gardening"], skipped: [] });
  expect(await readFile(taxonomyPath, "utf8")).toBe(HAND_KEPT
    .replace('"ex":[]}\n    ]},', '"ex":[]},\n      {"name":"Navigation","def":"Spatial navigation and place cells.","incl":[],"excl":[],"ex":[]}\n    ]},')
    .replace('"ex":[]}\n    ]}\n  ]', '"ex":[]},\n      {"name":"Gardening","def":"","incl":[],"excl":[],"ex":[]}\n    ]}\n  ]'));
  expect((await loadTaxonomy(dir, [])).leaves.map((l) => l.path)).toEqual([PAIN, MEMORY, "01 Brain/Navigation", SLEEP, "02 Mind/Gardening"]);

  // Spacing follows the domain's own lines; a layout that is not one leaf per line is rewritten as addleaf would.
  const root = await mkdtemp(join(tmpdir(), "rb-keep-"));
  try {
    await mkdir(join(root, "_system"));
    const spaced = HAND_KEPT.replace('{"name":"Sleep","def":"Sleep and circadian rhythms.","incl":[],"excl":[],"ex":[]}', '{"name": "Sleep", "def": "Sleep and circadian rhythms.", "incl": [], "excl": [], "ex": []}');
    await writeFile(join(root, "_system", "taxonomy.json"), spaced);
    expect(await taxonomyWith(root, [{ domain: "02 Mind", name: "Dreams", def: "꿈" }])).toBe(spaced.replace(
      '"ex": []}\n    ]}\n  ]', '"ex": []},\n      {"name": "Dreams", "def": "꿈", "incl": [], "excl": [], "ex": []}\n    ]}\n  ]'));
    const empty = HAND_KEPT.replace(/"leaves":\[\n {6}\{"name":"Sleep".*\n {4}\]/, '"leaves":[]');
    await writeFile(join(root, "_system", "taxonomy.json"), empty);
    const rewritten = await taxonomyWith(root, [{ domain: "02 Mind", name: "Dreams", def: "" }, { domain: "01 Brain", name: "Attention", def: "" }]);
    expect(rewritten).toStartWith('{\n "version": 2,\n "policy": {\n  "primary_rule": ');
    expect(JSON.parse(rewritten).domains.map((d: { leaves: { name: string }[] }) => d.leaves.map((l) => l.name))).toEqual([["Attention", "Memory", "Pain"], ["Dreams"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}));
