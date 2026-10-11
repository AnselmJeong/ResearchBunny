import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library } from "../src/service/db/database.ts";
import { LinkedDiscoveries } from "../src/service/providers/linked-discoveries.ts";
import { OpenAlex } from "../src/service/providers/openalex.ts";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
// Exercise the actual provider with an isolated library; never use personal data.
const root = await mkdtemp(join(tmpdir(), "researchbunny-linked-live-"));
const db = new Library(root);
try {
  const linked = new LinkedDiscoveries(db);
  const oa = new OpenAlex(db, () => process.env.OPENALEX_API_KEY);
  const signal = AbortSignal.timeout(120000);
  let linkedCalls = 0;
  const neighborhood = await linked.neighbors("38772598", 20, signal, () => linkedCalls++);
  assert(neighborhood.neighbors.length >= 20, "Linked Discoveries returned fewer than 20 neighbors");
  const pmids = neighborhood.neighbors.map((n) => n.pmid);
  const page = await oa.page({ filter: `pmid:${pmids.join("|")}`, per_page: "100" }, signal, () => {});
  const resolved = new Set(page.works.map((w) => w.pmid).filter((p) => pmids.includes(p)));
  const resolutionRate = resolved.size / pmids.length;
  assert(resolutionRate >= 0.9, `OpenAlex PMID resolution rate ${resolutionRate} is below 90%`);
  checks.push({ name: "Linked Discoveries", seedPmid: neighborhood.seedPmid, neighbors: pmids.length, resolved: resolved.size, resolutionRate, linkedCalls });
} finally {
  db.close();
  await rm(root, { recursive: true, force: true });
}
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
  "artifacts/qa/openalex-live.json",
  JSON.stringify({ work, search, citing }, null, 2),
);
console.log(JSON.stringify(checks, null, 2));
