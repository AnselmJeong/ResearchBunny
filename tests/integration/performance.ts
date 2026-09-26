import { Library } from "../../src/service/db/database";
import { blankWork } from "../../src/shared/domain";
import { DEFAULT_FILTERS } from "../../src/shared/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
if (!root) throw new Error("A disposable data path is required.");
const db = new Library(join(root, "library"));
const p = db.projects()[0].id;
db.transaction(() => {
  for (let i = 1; i <= 5000; i++) {
    const refs = Array.from(
      { length: 6 },
      (_, n) => "W" + (((i + n) % 500) + 1),
    );
    const w = db.upsert(
      blankWork({
        id: "perf-" + i,
        openalex: "W" + i,
        title: `Synthetic research fixture ${String(i).padStart(4, "0")}: Interoception and cognition`,
        authors: [`Author${i}, A`],
        year: 2000 + (i % 26),
        abstract:
          "Synthetic performance fixture. This is not an actual scientific paper.",
        references: refs,
        citekey: "perf" + i,
        source: "performance-fixture",
      }),
    ).work;
    db.mutate(p, [w.id], { screening: "included" }, false);
  }
});
const samples = [];
let result;
for (let i = 0; i < 10; i++) {
  const start = performance.now();
  result = db.list({
    projectId: p,
    scope: "archive",
    query: "",
    filters: DEFAULT_FILTERS,
    showHidden: false,
    offset: 0,
    limit: 500,
    sort: "title",
  });
  samples.push(performance.now() - start);
}
const report = {
  records: 5000,
  edges: (
    db.db.prepare("SELECT count(*) n FROM citations").get() as { n: number }
  ).n,
  listMs: samples,
  p95ListMs: [...samples].sort((a, b) => a - b)[9],
  returned: result?.works.length,
  graphEdges: result?.edges.length,
};
mkdirSync("artifacts/qa", { recursive: true });
writeFileSync(
  "artifacts/qa/performance-db.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
db.close();
