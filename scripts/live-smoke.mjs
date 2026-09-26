import { mkdir, writeFile } from "node:fs/promises";
const base = "https://api.openalex.org/";
const checks = [];
const request = async (path, params = {}) => {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`OpenAlex ${response.status}`);
  return response.json();
};
const search = await request("works", {
  search: "interoception social cognition",
  per_page: "2",
});
if (search.results.length !== 2)
  throw new Error("Search returned unexpected result count");
checks.push({
  name: "keyword search",
  count: search.results.length,
  total: search.meta.count,
});
const work = await request(
  "works/https://doi.org/10.1016/j.neuropsychologia.2017.01.001",
);
const id = work.id.split("/").at(-1);
checks.push({
  name: "DOI lookup",
  id,
  title: work.title,
  references: work.referenced_works?.length,
  abstractAvailable: !!work.abstract_inverted_index,
});
const citing = await request("works", { filter: `cites:${id}`, per_page: "2" });
if (!citing.results.every((w) => w.referenced_works.includes(work.id)))
  throw new Error("Citation direction did not match the provider data");
checks.push({
  name: "citing works",
  count: citing.results.length,
  total: citing.meta.count,
});
await mkdir("artifacts/qa", { recursive: true });
await writeFile(
  "artifacts/qa/live-openalex.json",
  JSON.stringify(
    { checkedAt: new Date().toISOString(), authenticated: false, checks },
    null,
    2,
  ),
);
await writeFile(
  "tests/fixtures/openalex-live.json",
  JSON.stringify({ work, search, citing }, null, 2),
);
console.log(JSON.stringify(checks, null, 2));
