// Shelf latency budgets on a synthetic 10,000-paper shelf with 500,000 citation rows.
// Run with a disposable data path: bun tests/integration/shelf-performance.ts /tmp/rb-shelf-perf
import { Library } from "../../src/service/db/database";
import { Shelf } from "../../src/service/shelf/indexer";
import { ShelfQueries } from "../../src/service/shelf/search";
import { OpenAlex } from "../../src/service/providers/openalex";
import { folderId } from "../../src/service/shelf/scanner";
import { normalize } from "../../src/service/providers/ollama-local";
import { blankWork } from "../../src/shared/domain";
import { DEFAULT_FILTERS } from "../../src/shared/types";
import { EMBED_PROMPTS } from "../../src/shared/shelf";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = process.argv[2];
if (!root) throw new Error("A disposable data path is required.");
const db = new Library(join(root, "library"));
const shelf = new Shelf(db, new OpenAlex(db, () => undefined), "", () => {}, () => ({}));
const queries = new ShelfQueries(db, shelf);
const projectId = db.projects()[0].id;
const N = 10_000, FOLDERS = 25, DIM = 768, MODEL = "perf@000000000000";
const rootId = randomUUID();
const words = "interoception anxiety dopamine memory cortex hippocampus depression stimulation cognition sleep pain attention autism psychosis learning reward network imaging genetics aging".split(" ");
const started = performance.now();
db.transaction(() => {
  db.db.prepare("INSERT INTO shelf_roots VALUES(?,?,?,?,?,NULL)").run(rootId, "/Volumes/PERF/Articles", "Articles", "[]", new Date().toISOString());
  db.db.prepare("INSERT INTO shelf_folders VALUES(?,?,?,?,?,1)").run(folderId(rootId, ""), rootId, "", null, "Articles");
  for (let f = 0; f < FOLDERS; f++)
    db.db.prepare("INSERT INTO shelf_folders VALUES(?,?,?,?,?,1)").run(folderId(rootId, `F${f}`), rootId, `F${f}`, folderId(rootId, ""), `Folder ${f}`);
  for (let i = 1; i <= N; i++) {
    const topic = [words[i % words.length], words[(i * 7) % words.length], words[(i * 13) % words.length]];
    const work = db.upsert(blankWork({
      id: "shelf-" + i,
      openalex: "W" + i,
      title: `Synthetic shelf paper ${i}: ${topic.join(" and ")}`,
      authors: [`Author${i}, A`],
      year: 1990 + (i % 36),
      abstract: `Synthetic abstract about ${topic.join(", ")}. Not an actual scientific paper.`,
      references: Array.from({ length: 50 }, (_, n) => "W" + (((i * 31 + n * 97) % N) + 1)),
      citekey: "shelf" + i,
      source: "openalex",
    })).work;
    const folder = folderId(rootId, `F${i % FOLDERS}`);
    db.db.prepare("INSERT INTO shelf_files VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'resolved','ok','{}',?,NULL)")
      .run(randomUUID(), rootId, folder, `F${i % FOLDERS}/${i}.pdf`, 1000, 1, "h" + i, 1000, 1, work.id, new Date().toISOString());
    const vector = normalize(Array.from({ length: DIM }, (_, d) => Math.sin(i * 0.37 + d * 0.11) + (d % 7 === i % 7 ? 1 : 0)));
    shelf.vectors.save(work.id, MODEL, EMBED_PROMPTS.version, "abstract", "x", vector);
    shelf.ftsRefresh(work.id);
  }
});
db.pref("shelf:modelKey", MODEL);
const setupSeconds = (performance.now() - started) / 1000;
const time = async (fn: () => unknown, n = 5) => {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); samples.push(performance.now() - t); }
  return Math.max(...samples.slice(1));
};
const folder = folderId(rootId, "F3");
const listArgs = { projectId, scope: "shelf", query: "", filters: DEFAULT_FILTERS, showHidden: false, offset: 0, limit: 100, sort: "rank" };
const report = {
  works: N,
  citations: (db.db.prepare("SELECT count(*) AS n FROM citations").get() as { n: number }).n,
  setupSeconds: Math.round(setupSeconds),
  folderListMs: await time(() => db.list({ ...listArgs, scopeId: folder })),
  folderSize: db.shelfScope(folder).length,
  shelfListMs: await time(() => db.list({ ...listArgs, scopeId: "all" })),
  edges500Ms: await time(() => db.edges(Array.from({ length: 500 }, (_, i) => "shelf-" + (i + 1)))),
  vectorLoadMs: await time(() => shelf.vectors.load(MODEL), 3),
  lexicalSearchMs: await time(() => queries.search("dopamine hippocampus memory", { limit: 30 })),
  relatedMs: await time(() => queries.related("shelf-42", { limit: 10, otherFoldersOnly: false })),
  matchShelfMs: await time(() => queries.matchShelf(db.get("shelf-77"))),
};
const budgets = { folderListMs: 300, shelfListMs: 1500, relatedMs: 150 };
mkdirSync("artifacts/qa", { recursive: true });
writeFileSync("artifacts/qa/performance-shelf.json", JSON.stringify({ report, budgets }, null, 2));
console.log(JSON.stringify(report, null, 2));
for (const [key, limit] of Object.entries(budgets))
  if ((report as Record<string, number>)[key] > limit) { console.error(`${key} ${(report as Record<string, number>)[key].toFixed(0)}ms exceeds ${limit}ms`); process.exitCode = 1; }
db.close();
