import { _electron as electron } from "playwright";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const data = await mkdtemp(join(tmpdir(), "researchbunny-live-"));
const executable = process.env.RESEARCHBUNNY_APP;
const env = {
  ...process.env,
  RESEARCHBUNNY_DATA_DIR: data,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const report = {
  checkedAt: new Date().toISOString(),
  packaged: !!executable,
  checks: [],
};
try {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: [resolve(".")] }),
    env,
  });
  const page = await app.firstWindow();
  const api = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.bunny[method](args), {
      method,
      args,
    });
  await page
    .getByRole("textbox", { name: "논문 검색", exact: true })
    .fill("10.1016/j.neuropsychologia.2017.01.001");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".paper-row").length === 1,
    undefined,
    { timeout: 60000 },
  );
  let snapshot = await api("snapshot");
  const projectId = snapshot.projects[0].id;
  const search = snapshot.runs[0];
  let result = await api("list", {
    projectId,
    scope: "run",
    scopeId: search.id,
    filters: search.filters,
  });
  assert.equal(result.works[0].openalex, "W2569940591");
  const work = result.works[0];
  assert.equal(work.abstract, null);
  report.checks.push({ name: "UI DOI search", count: result.total });
  await api("setSeeds", {
    projectId,
    ids: [work.id],
    question: "interoception social cognition",
  });
  const refs = await api("startRun", {
    projectId,
    mode: "references",
    query: "",
    ids: [work.id],
    filters: search.filters,
  });
  const wait = async (id) => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const latest = (await api("snapshot")).runs.find((r) => r.id === id);
      if (latest && !["queued", "running"].includes(latest.status)) {
        assert.equal(latest.status, "completed", latest.message);
        return latest;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Live job timed out");
  };
  await wait(refs.id);
  result = await api("list", {
    projectId,
    scope: "run",
    scopeId: refs.id,
    filters: search.filters,
    limit: 500,
  });
  assert(result.works.length > 100);
  assert(result.context.some((w) => w.id === work.id));
  const graphWorks = new Map(
    [...result.works, ...result.context].map((w) => [w.id, w]),
  );
  assert(
    result.edges.every(
      (e) =>
        e.source !== e.target &&
        graphWorks
          .get(e.source)
          .references.includes(graphWorks.get(e.target).openalex),
    ),
  );
  assert(result.edges.some((e) => e.source === work.id));
  report.checks.push({
    name: "live references",
    count: result.total,
    edges: result.edges.length,
  });
  const cited = await api("startRun", {
    projectId,
    mode: "citedBy",
    query: "",
    ids: [work.id],
    filters: search.filters,
  });
  await wait(cited.id);
  result = await api("list", {
    projectId,
    scope: "run",
    scopeId: cited.id,
    filters: search.filters,
    limit: 500,
  });
  assert(result.works.length >= 50);
  assert(result.works.every((w) => w.references.includes(work.openalex)));
  snapshot = await api("snapshot");
  assert.deepEqual(snapshot.seeds.ids, [work.id]);
  report.checks.push({
    name: "live cited-by and seed stability",
    count: result.total,
  });
  const runButton = page.locator(".recent-run").first();
  await runButton.click();
  await page.locator(".paper-row").first().waitFor();
  await page.locator(".paper-main").first().click();
  await page.screenshot({ path: "artifacts/qa/live-library.png" });
  await page.getByRole("button", { name: "그래프 보기", exact: true }).click();
  await page.locator(".graph-canvas canvas").first().waitFor();
  await page.screenshot({ path: "artifacts/qa/live-citation-graph.png" });
  report.checks.push({ name: "real network graph and inspector" });
  await mkdir("artifacts/qa", { recursive: true });
  await writeFile(
    "artifacts/qa/live-desktop.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (app) await app.close();
  await rm(data, { recursive: true, force: true });
}
