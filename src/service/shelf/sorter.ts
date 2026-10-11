import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { Library } from "../db/database";
import { DEFAULT_AI, type AIConfig, type AIProvider } from "../providers/openai";
import type { FileRow, Shelf } from "./indexer";
import type { ShelfQueries } from "./search";
import { parentRel, rootOnline } from "./scanner";
import { AppError, DEFAULT_FILTERS, now, type AppEvent, type Run, type Work } from "../../shared/types";
import {
  SHELF_DUPLICATED,
  SHELF_UNCATEGORIZED,
  isInboxFolder,
  titleKey,
  type ShelfFileInfo,
  type ShelfSortItem,
  type ShelfSortJob,
  type ShelfSortLeaf,
  type ShelfSortResult,
  type ShelfSortState,
  type ShelfSortVote,
} from "../../shared/shelf";

// 수신함 정리: the in-app version of `_system/intake.py` + ROUTING.md. Nearest
// filed neighbours propose folders, the configured AI decides with the
// taxonomy's rules, the user approves, and only then are PDFs moved.

const STATE_KEY = "shelf:sort";
/** Neighbours per paper and the softmax temperature over their cosine (a 0.1 gap weighs ~7x). */
const NEIGHBOURS = 20;
const TEMPERATURE = 0.05;
const MAX_VOTES = 5;
/** Folders below this vote share are noise, for the reviewer and the AI alike. */
const MIN_SHARE = 0.05;
const MAX_BATCH = 40;
const TEXT_CHARS = 900;
/** intake.py: the same title with a size within 2% is a duplicate; a larger gap is another version. */
const SIZE_TOLERANCE = 0.02;
/** Short generic titles ("Editorial") never match by title alone. */
const TITLE_KEY_MIN = 20;
/** `intake.py reindex` leaves these folders out of index.json. */
const INDEX_SKIP = new Set(["_news", "_system", "_to_delete"]);
const DEFAULT_POLICY = {
  primary_rule: "Assign the single leaf that best matches the paper's PRIMARY subject, not every topic it touches.",
  tie_breakers: ["When two leaves fit equally, prefer the more specific one."],
  confidence: {
    HIGH: "Title alone makes the leaf obvious.",
    MEDIUM: "Leaf is clear after reading the abstract; a sibling leaf was plausible.",
    LOW: "No leaf fits well, or 3+ leaves fit equally -> leave the paper uncategorized.",
  },
};
const INSTRUCTION = "Sort new PDFs of a personal research library into its folder taxonomy. Give each paper the single leaf (folder) that matches its PRIMARY subject, following policy and its tie-breakers. leaves lists every folder with its definition; rules adds include/exclude notes for the leaves named in candidates. candidates are the folders holding the library's most similar already-filed papers, with similarity-weighted vote shares: strong evidence, but check the rules and choose another leaf when the paper's primary subject fits it better. Return leaf null with confidence low when no leaf fits well or three or more fit equally; never force a paper into a leaf. confidence: high = the title alone makes the leaf obvious; medium = clear after the text though a sibling leaf was plausible; low = leave uncategorized. reason: one short Korean sentence (at most 80 characters) naming the deciding subject. Return exactly one decision per paper index, using leaf numbers from leaves.";
const decisionSchema = z.object({
  decisions: z.array(z.object({
    paper: z.number().int().nonnegative(),
    leaf: z.number().int().positive().nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    reason: z.string().trim().min(1).max(400),
  })),
});
const outputSchema = z.toJSONSchema(decisionSchema, { target: "draft-7" });
type Decision = z.infer<typeof decisionSchema>["decisions"][number];

const taxonomySchema = z.object({
  policy: z.unknown().optional(),
  domains: z.array(z.object({
    name: z.string(),
    leaves: z.array(z.object({
      name: z.string(),
      def: z.string().optional(),
      incl: z.array(z.string()).optional(),
      excl: z.array(z.string()).optional(),
    })),
  })),
});
interface Leaf extends ShelfSortLeaf {
  incl: string[];
  excl: string[];
}
export interface Taxonomy {
  source: "file" | "folders";
  leaves: Leaf[];
  policy: unknown;
}
type Row = FileRow & { folder: string };

/** One path segment that stays inside the root: no separators, dot-names or `_` system folders. */
const safeSegment = (name: string) => !!name && name === name.trim() && !/[/\\\0]/.test(name) && !name.startsWith(".") && !name.startsWith("_");
const parseInfo = (row: Pick<FileRow, "info">): ShelfFileInfo => JSON.parse(row.info || "{}");
const round = (n: number) => Math.round(n * 1000) / 1000;
const sameSize = (a: number, b: number) => Math.abs(a - b) <= SIZE_TOLERANCE * Math.max(a, b);
const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
const exists = (path: string) => lstat(path).then(() => true, () => false);
const patch = (item: ShelfSortItem, value: Partial<ShelfSortItem>) => Object.assign(item, value);
const job = (status: ShelfSortJob["status"], message: string, done?: number, total?: number): ShelfSortJob =>
  ({ status, message, ...(total ? { done, total } : {}), updatedAt: now() });
const emptyState = (): ShelfSortState =>
  ({ job: job("idle", ""), createdAt: null, taxonomy: null, leaves: [], items: [], waiting: [], ledger: false });

/** Local time as Python's `datetime.now().isoformat()`, matching intake.py's logs. */
function localStamp(date = new Date(), seconds = false) {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return seconds ? base : `${base}.${pad(date.getMilliseconds(), 3)}`;
}
/** `json.dumps` spacing, so move_log.jsonl keeps one style. */
const pyJson = (value: Record<string, unknown>) =>
  `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")}}`;

/**
 * Destinations: `_system/taxonomy.json` (intake.py's single source of truth),
 * or every leaf folder outside the inbox and `_` folders when there is none.
 */
export async function loadTaxonomy(rootPath: string, folders: string[]): Promise<Taxonomy> {
  const text = await readFile(join(rootPath, "_system", "taxonomy.json"), "utf8").catch(() => null);
  if (text !== null) {
    let parsed: z.infer<typeof taxonomySchema>;
    try {
      parsed = taxonomySchema.parse(JSON.parse(text));
    } catch {
      throw new AppError("SHELF_TAXONOMY", "_system/taxonomy.json을 읽지 못했습니다. 파일 형식을 확인하세요.");
    }
    const leaves = parsed.domains.flatMap((d) => safeSegment(d.name)
      ? d.leaves.filter((l) => safeSegment(l.name)).map((l) => ({ path: `${d.name}/${l.name}`, domain: d.name, name: l.name, def: l.def?.trim() || "", incl: l.incl || [], excl: l.excl || [] }))
      : []);
    if (!leaves.length) throw new AppError("SHELF_TAXONOMY", "_system/taxonomy.json에 분류 폴더가 없습니다.");
    return { source: "file", leaves, policy: parsed.policy ?? DEFAULT_POLICY };
  }
  const visible = folders.filter((f) => f && f.split("/").every(safeSegment));
  const leaves = visible
    .filter((f) => !visible.some((other) => other.startsWith(f + "/")))
    .sort()
    .map((path) => ({ path, domain: parentRel(path) || "", name: basename(path), def: "", incl: [], excl: [] }));
  return { source: "folders", leaves, policy: DEFAULT_POLICY };
}

/** Similarity-weighted folder vote over a paper's nearest filed neighbours. */
export function tally(neighbours: { path: string; score: number }[]): ShelfSortVote[] {
  if (!neighbours.length) return [];
  const top = Math.max(...neighbours.map((n) => n.score));
  const folders = new Map<string, { weight: number; similarity: number }>();
  let total = 0;
  for (const n of neighbours) {
    const weight = Math.exp((n.score - top) / TEMPERATURE);
    total += weight;
    const folder = folders.get(n.path) || { weight: 0, similarity: -1 };
    folders.set(n.path, { weight: folder.weight + weight, similarity: Math.max(folder.similarity, n.score) });
  }
  return [...folders]
    .map(([path, v]) => ({ path, share: round(v.weight / total), similarity: round(v.similarity) }))
    .sort((a, b) => b.share - a.share || a.path.localeCompare(b.path))
    .filter((vote, index) => index === 0 || vote.share >= MIN_SHARE)
    .slice(0, MAX_VOTES);
}

/** Keep each paper's first valid decision; papers without one fall back to the vote. */
export function readDecisions(raw: unknown, papers: number, leaves: number): Map<number, Decision> {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("AI_FORMAT", "AI 판정 형식이 올바르지 않습니다.");
  const decisions = new Map<number, Decision>();
  for (const d of parsed.data.decisions)
    if (d.paper < papers && !decisions.has(d.paper) && (d.leaf === null || d.leaf <= leaves)) decisions.set(d.paper, d);
  return decisions;
}

/** Rebuild `index.json` the way `intake.py reindex` does (version 2; root PDFs are not listed). */
export async function writeIndex(rootPath: string) {
  const index = { version: 2, generated: localStamp(new Date(), true), categories: {} as Record<string, string[]>, files: {} as Record<string, { category: string }> };
  const visit = async (rel: string) => {
    const entries = await readdir(rel ? join(rootPath, rel) : rootPath, { withFileTypes: true });
    const pdfs = entries.filter((e) => !e.isDirectory() && !e.name.startsWith(".") && e.name.toLowerCase().endsWith(".pdf")).map((e) => e.name).sort();
    if (rel && pdfs.length) {
      index.categories[rel] = pdfs;
      for (const name of pdfs) index.files[name] = { category: rel };
    }
    for (const e of entries)
      if (e.isDirectory() && !INDEX_SKIP.has(e.name) && !e.name.startsWith(".") && !e.name.startsWith("_summaries"))
        await visit(rel ? `${rel}/${e.name}` : e.name);
  };
  await visit("");
  const temp = join(rootPath, ".index.json.researchbunny");
  await writeFile(temp, JSON.stringify(index, null, 1));
  await rename(temp, join(rootPath, "index.json"));
}

async function freeName(dir: string, name: string) {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let k = 2; await exists(join(dir, candidate)); k++) candidate = `${stem} (${k})${ext}`;
  return candidate;
}

export class ShelfSorter {
  active: AbortController | null = null;
  private applying = false;

  constructor(
    private db: Library,
    private shelf: Shelf,
    private queries: ShelfQueries,
    private ai: Pick<AIProvider, "structured">,
    private emit: (event: AppEvent) => void,
  ) {
    const saved = this.state();
    if (saved.job.status === "running") this.save({ ...saved, job: job("failed", "앱 종료로 수신함 정리 제안이 중단되었습니다. 다시 만드세요.") });
  }

  state(): ShelfSortState {
    return { ...emptyState(), ...this.db.pref<ShelfSortState>(STATE_KEY) };
  }
  private save(state: ShelfSortState) {
    this.db.pref(STATE_KEY, state);
    this.emit({ type: "shelf" });
  }
  private progress(message: string, done?: number, total?: number) {
    this.save({ ...this.state(), job: job("running", message, done, total) });
  }
  private rows(rootId: string): Row[] {
    return this.db.db.prepare(
      "SELECT f.*,fo.rel_path AS folder FROM shelf_files f JOIN shelf_folders fo ON fo.id=f.folder_id WHERE f.root_id=? AND f.status!='missing' ORDER BY f.rel_path",
    ).all(rootId) as Row[];
  }
  private folders(rootId: string) {
    return (this.db.db.prepare("SELECT rel_path FROM shelf_folders WHERE root_id=? AND present=1").all(rootId) as { rel_path: string }[]).map((r) => r.rel_path);
  }

  start(): ShelfSortState {
    if (this.active || this.applying) throw new AppError("BUSY", this.active ? "수신함 정리 제안을 만드는 중입니다." : "파일을 옮기는 중입니다. 끝난 뒤 다시 만드세요.");
    if (!this.shelf.root() || !this.shelf.config()) throw new AppError("SHELF_CONFIG", "서고를 먼저 연결하세요.");
    if (!{ ...DEFAULT_AI, ...this.db.pref<AIConfig>("ai") }.aiEnabled)
      throw new AppError("AI_DISABLED", "설정에서 AI 연결을 선택하고 AI 추천·분류를 활성화하세요. 수신함 정리는 임베딩 후보와 AI 판정을 함께 씁니다.");
    const control = new AbortController();
    this.active = control;
    const state = { ...emptyState(), job: job("running", "새 PDF를 색인하고 있습니다.") };
    this.save(state);
    void this.execute(control.signal)
      .catch((error) => this.save({
        ...this.state(),
        job: control.signal.aborted
          ? job("cancelled", "수신함 정리 제안을 취소했습니다. 파일은 그대로입니다.")
          : job("failed", error instanceof AppError ? error.message : "수신함 정리 제안을 만들지 못했습니다. 파일은 그대로입니다."),
      }))
      .finally(() => {
        this.active = null;
        this.emit({ type: "changed" });
      });
    return state;
  }
  cancel() {
    this.active?.abort();
  }

  private async execute(signal: AbortSignal) {
    // New PDFs are hashed, read and embedded first; a paused shelf sorts what is already indexed.
    await this.shelf.scan("sort");
    signal.throwIfAborted();
    const root = this.shelf.root();
    if (!root) throw new AppError("SHELF_CONFIG", "서고를 먼저 연결하세요.");
    if (!(await rootOnline(root.path))) throw new AppError("SHELF_OFFLINE", "서고 오프라인 · NAS를 연결한 뒤 다시 만드세요.");
    const taxonomy = await loadTaxonomy(root.path, this.folders(root.id));
    if (!taxonomy.leaves.length) throw new AppError("SHELF_TAXONOMY", "옮길 분류 폴더가 없습니다. 서고에 폴더를 만들거나 _system/taxonomy.json을 두세요.");
    const ledger = await isDir(join(root.path, "_system"));
    const leafOf = new Map(taxonomy.leaves.map((l) => [l.path.normalize("NFC"), l.path]));
    const rows = this.rows(root.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const library = rows.filter((r) => !isInboxFolder(r.folder));
    const inbox = rows.filter((r) => isInboxFolder(r.folder));

    // Existing copies, first by path as in the shelf's own duplicate rule.
    const titleOf = (row: Row) => titleKey(parseInfo(row).parsed?.title || "");
    const known = { hash: new Map<string, Row>(), work: new Map<string, Row>(), title: new Map<string, Row>() };
    const remember = (row: Row) => {
      if (row.hash && !known.hash.has(row.hash)) known.hash.set(row.hash, row);
      if (row.work_id && !known.work.has(row.work_id)) known.work.set(row.work_id, row);
      const key = titleOf(row);
      if (key.length >= TITLE_KEY_MIN && !known.title.has(key)) known.title.set(key, row);
    };
    library.forEach(remember);
    const copyOf = (row: Row): { row: Row; exact: boolean } | null => {
      const primary = parseInfo(row).duplicateOf;
      const twin = (row.hash && known.hash.get(row.hash)) || (primary ? byId.get(primary) : undefined);
      if (twin && twin.id !== row.id) return { row: twin, exact: true };
      const same = (row.work_id && known.work.get(row.work_id)) || known.title.get(titleOf(row));
      return same && same.id !== row.id ? { row: same, exact: false } : null;
    };

    const items: ShelfSortItem[] = [];
    const waiting: ShelfSortState["waiting"] = [];
    const judge: { row: Row; work: Work; item: ShelfSortItem }[] = [];
    for (const row of inbox) {
      if (!row.work_id || (row.status !== "failed" && (row.stage === "found" || row.stage === "hashed"))) {
        waiting.push({ fileId: row.id, relPath: row.rel_path, reason: "색인 대기 · 색인이 끝나면 다시 만드세요" });
        continue;
      }
      const work = this.db.get(row.work_id);
      const info = parseInfo(row);
      const item: ShelfSortItem = {
        fileId: row.id, relPath: row.rel_path, folder: row.folder, title: work.title || info.parsed?.title || basename(row.rel_path),
        year: work.year ?? info.parsed?.year ?? null, authors: work.authors.slice(0, 3),
        target: null, source: "ai", confidence: null, reason: "", votes: [], agree: null,
      };
      items.push(item);
      const copy = copyOf(row);
      if (copy && (copy.exact || sameSize(copy.row.size, row.size))) {
        patch(item, { target: SHELF_DUPLICATED, source: "duplicate", confidence: "high", existing: copy.row.rel_path,
          reason: copy.exact ? "같은 파일이 이미 서고에 있습니다." : "같은 논문의 크기가 같은 사본(2% 이내)이 이미 서고에 있습니다." });
        continue;
      }
      remember(row);
      const filed = copy && leafOf.get(copy.row.folder.normalize("NFC"));
      if (filed) {
        patch(item, { target: filed, source: "version", confidence: "high", existing: copy.row.rel_path, reason: "다른 판본이 이미 이 폴더에 있습니다." });
        continue;
      }
      judge.push({ row, work, item });
    }

    // Folder votes from the nearest filed papers (local embeddings; skipped while Ollama is off).
    this.progress("임베딩으로 비슷한 논문의 폴더를 찾고 있습니다.");
    const filedWork = new Map<string, string>();
    for (const row of library) {
      const leaf = leafOf.get(row.folder.normalize("NFC"));
      if (leaf && row.work_id && row.status !== "auxiliary" && !filedWork.has(row.work_id)) filedWork.set(row.work_id, leaf);
    }
    let semantic = 0;
    for (const { work, item } of judge) {
      signal.throwIfAborted();
      const source = await this.queries.workVector(work, AbortSignal.any([signal, AbortSignal.timeout(30000)])).catch(() => null);
      const key = this.shelf.currentModelKey();
      if (!source || !key) continue;
      this.shelf.vectors.ensure(key);
      const hits = this.shelf.vectors.search(source.vector, NEIGHBOURS, (id) => id !== work.id && filedWork.has(id));
      item.votes = tally(hits.map((h) => ({ path: filedWork.get(h.id)!, score: h.score })));
      if (item.votes.length) semantic++;
    }

    const failed = await this.decide(taxonomy, judge, signal);
    const movable = items.filter((i) => i.target && i.target !== i.folder).length;
    const notes = [
      waiting.length ? `색인 대기 ${waiting.length}편` : "",
      judge.length && !semantic ? "Ollama 꺼짐 · 임베딩 후보 없이 AI만 판정" : "",
      failed ? `AI 판정 실패 ${failed}편 · 임베딩 1위만 표시` : "",
    ].filter(Boolean);
    this.save({
      job: job("ready", `${items.length}편 제안 · 옮길 논문 ${movable}편${notes.length ? ` · ${notes.join(" · ")}` : ""}`),
      createdAt: now(),
      taxonomy: taxonomy.source,
      leaves: taxonomy.leaves.map(({ path, domain, name, def }) => ({ path, domain, name, def })),
      items,
      waiting,
      ledger,
    });
  }

  /** AI decisions in budget-sized batches; returns how many papers fell back to the vote. */
  private async decide(taxonomy: Taxonomy, judge: { row: Row; work: Work; item: ShelfSortItem }[], signal: AbortSignal) {
    if (!judge.length) return 0;
    const config = { ...DEFAULT_AI, ...this.db.pref<AIConfig>("ai") };
    const number = new Map(taxonomy.leaves.map((l, i) => [l.path, i + 1]));
    const fixed = { policy: taxonomy.policy, leaves: taxonomy.leaves.map((l, i) => ({ leaf: i + 1, path: l.path, ...(l.def ? { def: l.def } : {}) })) };
    const ruleOf = (leaf: Leaf) => ({ leaf: number.get(leaf.path)!, include: leaf.incl, exclude: leaf.excl });
    const ruled = (leaf: Leaf) => leaf.incl.length + leaf.excl.length > 0;
    const leafByPath = new Map(taxonomy.leaves.map((l) => [l.path, l]));
    const paper = ({ row, work, item }: (typeof judge)[number]) => {
      const info = parseInfo(row);
      return {
        title: item.title.slice(0, 400),
        year: item.year,
        ...(work.venue ? { venue: work.venue.slice(0, 200) } : {}),
        text: (work.abstract || info.abstract || info.page1 || "").replace(/\s+/g, " ").trim().slice(0, TEXT_CHARS),
        candidates: item.votes.map((v) => ({ leaf: number.get(v.path)!, share: v.share })),
      };
    };
    const rulesFor = (entry: (typeof judge)[number]) =>
      entry.item.votes.map((v) => leafByPath.get(v.path)!).filter(ruled);
    const payload = (batch: typeof judge) => {
      const rules = [...new Set(batch.flatMap(rulesFor))].map(ruleOf);
      return { ...fixed, rules, papers: batch.map((entry, index) => ({ paper: index, ...paper(entry) })) };
    };
    // AIProvider budgets each call by UTF-8 bytes of data + instruction + schema + 2,000.
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const base = bytes(payload([])) + Buffer.byteLength(INSTRUCTION) + bytes(outputSchema) + 2000;
    // Output stays small enough for API max_output_tokens: about 110 tokens per Korean decision.
    const maxBatch = Math.max(1, Math.min(MAX_BATCH, Math.floor((config.aiMaxOutputTokens - 300) / 110)));
    const cost = (entry: (typeof judge)[number], index: number, seen: Set<Leaf>) =>
      bytes({ paper: index, ...paper(entry) }) + 1 + rulesFor(entry).filter((l) => !seen.has(l)).reduce((sum, l) => sum + bytes(ruleOf(l)) + 1, 0);
    const batches: (typeof judge)[] = [];
    let current: typeof judge = [], size = base, seen = new Set<Leaf>();
    for (const entry of judge) {
      let add = cost(entry, current.length, seen);
      if (current.length && (current.length >= maxBatch || size + add > config.aiMaxInputTokens)) {
        batches.push(current);
        current = [];
        size = base;
        seen = new Set();
        add = cost(entry, 0, seen);
      }
      if (size + add > config.aiMaxInputTokens)
        throw new AppError("BUDGET", `수신함 정리에 필요한 AI 입력 예산이 부족합니다 (분류 기준과 논문 한 편에 약 ${Math.ceil((size + add) / 1000)}KB). 설정의 AI 입력 상한을 늘리세요.`);
      current.push(entry);
      size += add;
      rulesFor(entry).forEach((l) => seen.add(l));
    }
    if (current.length) batches.push(current);

    let failed = 0;
    let stop = "";
    for (const [n, batch] of batches.entries()) {
      signal.throwIfAborted();
      this.progress(`AI 판정 중 · ${n + 1}/${batches.length} 묶음 (${judge.length}편)`, n, batches.length);
      const decisions = new Map<number, Decision>();
      if (!stop) {
        // A malformed answer gets one fresh attempt; provider errors (quota, login, budget) stop further calls.
        for (let attempt = 0; attempt < 2 && decisions.size < batch.length; attempt++) {
          try {
            const raw = await this.ai.structured(this.run(batch.length), "shelf_sort", outputSchema, INSTRUCTION, payload(batch), AbortSignal.any([signal, AbortSignal.timeout(240000)]), false);
            const next = readDecisions(raw, batch.length, taxonomy.leaves.length);
            for (const [index, decision] of next) if (!decisions.has(index)) decisions.set(index, decision);
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof AppError && error.code === "AI_FORMAT")) {
              stop = error instanceof Error ? error.message : "AI 요청이 실패했습니다.";
              break;
            }
          }
        }
      }
      batch.forEach(({ item }, index) => {
        const decision = decisions.get(index);
        if (!decision) {
          failed++;
          patch(item, { source: "embedding", target: item.votes[0]?.path ?? null, reason: stop ? `AI 판정 실패: ${stop}` : "AI가 이 논문을 판정하지 않았습니다." });
          return;
        }
        const leaf = decision.leaf ? taxonomy.leaves[decision.leaf - 1] : null;
        const target = leaf && decision.confidence !== "low" ? leaf.path : SHELF_UNCATEGORIZED;
        patch(item, {
          source: "ai", confidence: decision.confidence, reason: decision.reason.slice(0, 200), target,
          agree: target !== SHELF_UNCATEGORIZED && item.votes.length ? item.votes[0].path === target : null,
        });
      });
    }
    return failed;
  }

  /** Each batch is its own budget run, so one large inbox never exhausts a single run's allowance. */
  private run(count: number): Run {
    return {
      id: randomUUID(), projectId: "shelf", mode: "ai", query: "서고 수신함 정리", seedProfileId: null,
      inputIds: [], filters: DEFAULT_FILTERS, status: "running", createdAt: now(), updatedAt: now(),
      calls: 0, maxCalls: 1, maxCandidates: count, total: count, count, message: "", tasks: [], rankingVersion: "shelf-sort-1",
    };
  }

  /**
   * Move approved inbox PDFs. Names never change; a taken name gets " (2)" as in
   * intake.py. With `_system` present every move is logged before it happens and
   * index.json is rebuilt, so intake.py and the app can keep taking turns.
   */
  async apply(requested: { fileId: string; target: string }[]): Promise<ShelfSortResult> {
    if (this.active) throw new AppError("BUSY", "제안을 만드는 중에는 파일을 옮길 수 없습니다.");
    const root = this.shelf.root(), config = this.shelf.config();
    if (!root || !config) throw new AppError("SHELF_CONFIG", "서고를 먼저 연결하세요.");
    if (!(await rootOnline(root.path))) throw new AppError("SHELF_OFFLINE", "서고 오프라인 · NAS를 연결한 뒤 옮기세요.");
    const folders = this.folders(root.id);
    const taxonomy = await loadTaxonomy(root.path, folders);
    const allowed = new Set([...taxonomy.leaves.map((l) => l.path), SHELF_UNCATEGORIZED, SHELF_DUPLICATED]);
    // Reuse an existing folder's on-disk spelling (SMB names may be NFD).
    const onDisk = new Map(folders.map((f) => [f.normalize("NFC"), f]));
    const excluded = new Set(config.exclude.map((name) => name.normalize("NFC")));
    const ledger = await isDir(join(root.path, "_system"));
    const moveLog = join(root.path, "_system", "move_log.jsonl");
    this.applying = true;
    return this.shelf.hold(async () => {
      const result: ShelfSortResult = { moved: 0, uncategorized: 0, duplicated: 0, skipped: [] };
      const filed: string[] = [], parked: string[] = [], done = new Set<string>();
      for (const { fileId, target } of requested) {
        const row = this.shelf.file(fileId);
        const skip = (reason: string) => result.skipped.push({ relPath: row?.rel_path || fileId, reason });
        if (!row || row.root_id !== root.id || row.status === "missing") { skip("서고에서 찾을 수 없습니다."); continue; }
        const from = parentRel(row.rel_path) ?? "";
        if (!isInboxFolder(from)) { skip("이미 수신함 밖에 있습니다."); continue; }
        if (!allowed.has(target)) { skip("분류 기준에 없는 폴더입니다."); continue; }
        const dir = onDisk.get(target.normalize("NFC")) ?? target;
        if (dir === from) { done.add(fileId); continue; }
        const src = join(root.path, row.rel_path);
        const before = await lstat(src).catch(() => null);
        if (!before?.isFile()) { skip("파일이 없습니다. 서고를 다시 스캔하세요."); continue; }
        if (before.size !== row.size) { skip("파일이 바뀌었습니다. 제안을 다시 만드세요."); continue; }
        await mkdir(join(root.path, dir), { recursive: true });
        const rel = `${dir}/${await freeName(join(root.path, dir), basename(row.rel_path))}`;
        const entry = { id: -100, src: row.rel_path, dst: rel, st: "moving", ts: localStamp(), by: "ResearchBunny" };
        if (ledger) await appendFile(moveLog, pyJson(entry) + "\n");
        try {
          await rename(src, join(root.path, rel));
        } catch (error) {
          if (ledger) await appendFile(moveLog, pyJson({ ...entry, st: "failed", ts: localStamp() }) + "\n").catch(() => {});
          skip(`옮기지 못했습니다 (${(error as NodeJS.ErrnoException).code || "unknown"}).`);
          continue;
        }
        done.add(fileId);
        if (dir.split("/").some((part) => excluded.has(part.normalize("NFC")))) this.shelf.release(row.id, join(root.path, rel));
        else this.shelf.relocate(row.id, rel, Math.trunc((await stat(join(root.path, rel)).catch(() => before)).mtimeMs));
        if (target === SHELF_UNCATEGORIZED) result.uncategorized++;
        else if (target === SHELF_DUPLICATED) result.duplicated++;
        else result.moved++;
        (target === SHELF_UNCATEGORIZED || target === SHELF_DUPLICATED ? parked : filed).push(rel);
      }
      if (ledger && filed.length + parked.length) {
        const day = localStamp().slice(0, 10);
        await mkdir(join(root.path, "_system", "logs"), { recursive: true });
        await appendFile(join(root.path, "_system", "logs", `intake-${day}.md`),
          `\n## run ${localStamp(new Date(), true)} · ResearchBunny\n${filed.map((r) => `- ${r}\n`).join("")}${parked.map((r) => `- (uncategorized) ${r}\n`).join("")}`);
        await writeIndex(root.path);
      }
      const state = this.state();
      const items = state.items.filter((i) => !done.has(i.fileId));
      const left = items.filter((i) => i.target && i.target !== i.folder).length;
      this.save({
        ...state,
        items,
        job: state.job.status === "ready"
          ? job("ready", `${result.moved + result.uncategorized + result.duplicated}편을 옮겼습니다.${left ? ` 옮기지 않은 제안 ${left}편.` : ""}`)
          : state.job,
      });
      return result;
    }).finally(() => {
      this.applying = false;
    });
  }
}
