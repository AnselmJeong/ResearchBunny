// Warm the real provider cache with deterministic data; the desktop test then
// exercises the unchanged renderer, IPC, discovery engine and SQLite service.
import { Library } from "../../src/service/db/database";
import { OpenAlex } from "../../src/service/providers/openalex";
import { Discovery } from "../../src/service/discovery/engine";
import { DEFAULT_FILTERS } from "../../src/shared/types";
const db = new Library(process.argv[2]);
const projectId = db.projects()[0].id;
const graph = Array.from({ length: 35 }, (_, i) => ({
  id: `https://openalex.org/W${i + 1}`,
  title: `Navigation research ${String(i + 1).padStart(2, "0")}`,
  publication_year: 2000 + i,
  type: "article",
  cited_by_count: i + 1,
  referenced_works: (i < 10
    ? [11, 12, 13, 14, 15]
    : i >= 15
      ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      : []
  ).map((n) => `https://openalex.org/W${n}`),
  abstract_inverted_index: { navigation: [0], research: [1] },
}));
const fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = async (input) => {
  const url = new URL(String(input));
  const filter = url.searchParams.get("filter") || "";
  const results = filter.startsWith("cites:")
    ? graph.filter((w) =>
        w.referenced_works.includes(`https://openalex.org/${filter.slice(6)}`),
      )
    : filter.startsWith("openalex:")
      ? graph.filter((w) =>
          filter.slice(9).split("|").includes(w.id.split("/").at(-1)!),
        )
      : graph.slice(0, 10);
  return new Response(
    JSON.stringify({
      results,
      meta: { count: results.length, next_cursor: null },
    }),
  );
};
async function main() {
  const discovery = new Discovery(
    db,
    new OpenAlex(db, () => undefined, fetcher),
    () => {},
  );
  async function done(id: string) {
    for (let n = 0; n < 600; n++) {
      const run = db.run(id);
      if (run.status === "completed") return;
      if (!["queued", "running"].includes(run.status))
        throw new Error(JSON.stringify(run));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Fixture timed out");
  }
  const search = discovery.start({
    projectId,
    mode: "search",
    query: "navigation research",
    ids: [],
    filters: DEFAULT_FILTERS,
  });
  await done(search.id);
  const related = discovery.start({
    projectId,
    mode: "related",
    query: "navigation research",
    ids: db.candidates(search.id).map((c) => c.work.id),
    filters: DEFAULT_FILTERS,
  });
  await done(related.id);
  db.db.exec(
    "DELETE FROM candidates; DELETE FROM runs; DELETE FROM project_works;",
  );
  db.close();
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
