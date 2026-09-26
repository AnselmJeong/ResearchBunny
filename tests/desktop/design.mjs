import { _electron as electron } from "playwright";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const data = await mkdtemp(join(tmpdir(), "researchbunny-design-"));
const artifact = process.env.RESEARCHBUNNY_APP;
const report = { artifact: artifact || "development", checks: [], errors: [] };
await mkdir("artifacts/qa", { recursive: true });
await build({
  entryPoints: ["tests/desktop/navigation-fixture.ts"],
  outfile: "dist/integration-tests-navigation.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["better-sqlite3"],
});
const fixture = spawnSync(
  require("electron"),
  ["dist/integration-tests-navigation.cjs", join(data, "library")],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" },
);
assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);
let app, page;
const api = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.bunny[method](args), {
    method,
    args,
  });
async function launch() {
  const env = {
    ...process.env,
    RESEARCHBUNNY_DATA_DIR: data,
    ...(artifact ? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    ...(artifact
      ? { executablePath: artifact, args: [] }
      : { args: [resolve(".")] }),
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => report.errors.push(String(e)));
  await page.locator(".workspace-heading").waitFor();
  if (
    !(await page
      .getByRole("textbox", { name: "논문 검색", exact: true })
      .count())
  )
    await page.getByRole("button", { name: "문헌 탐색", exact: true }).click();
  await page.getByRole("textbox", { name: "논문 검색", exact: true }).waitFor();
}
async function pollSnapshot(projectId, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const snapshot = await api("snapshot", projectId ? { projectId } : {});
    const value = predicate(snapshot);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Snapshot condition timed out");
}
async function waitRun(mode, previousId) {
  const run = await pollSnapshot(undefined, (s) =>
    s.runs.find(
      (r) => r.mode === mode && r.id !== previousId && r.status === "completed",
    ),
  );
  await page.locator('.run-trail button[aria-current="step"]').waitFor();
  return run;
}
try {
  await launch();
  const projectId = (await api("snapshot")).projects[0].id;
  await page
    .getByRole("textbox", { name: "논문 검색", exact: true })
    .fill("navigation research");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  const search = await waitRun("search");
  await page.locator(".paper-row").first().waitFor();
  const boxes = page.locator('.paper-row input[type="checkbox"]');
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();
  const searchList = await api("list", {
    projectId,
    scope: "run",
    scopeId: search.id,
    filters: search.filters,
  });
  const sourceIds = searchList.works.slice(0, 3).map((w) => w.id);
  await page.locator(".paper-main").first().click();
  await page.getByRole("tab", { name: "초록", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "관련 문헌 찾기", exact: true })
    .click();
  await page.screenshot({
    animations: "disabled",
    path: "artifacts/qa/design-discovery.png",
  });
  await page
    .locator(".discovery-popover")
    .getByRole("button", { name: "관련 논문", exact: true })
    .click();
  const related = await waitRun("related");
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  await page
    .getByRole("button", { name: "관련 문헌 찾기", exact: true })
    .click();
  await page
    .locator(".discovery-popover")
    .getByRole("button", { name: "후속 인용", exact: true })
    .click();
  const cited = await waitRun("citedBy");
  await page.locator(".paper-main").first().click();
  await page.getByRole("tab", { name: "발견 근거", exact: true }).click();
  await page.getByRole("button", { name: "그래프 보기", exact: true }).click();
  await page.locator(".graph-canvas canvas").first().waitFor();
  await api("saveSettings", {
    ...(await api("snapshot")).settings,
    theme: "dark",
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await page.screenshot({
    animations: "disabled",
    path: "artifacts/qa/design-graph.png",
  });
  await api("saveSettings", {
    ...(await api("snapshot")).settings,
    theme: "light",
  });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "light",
  );
  await page.locator(".history-nav").click();
  await page.locator(".history-stage").first().waitFor();
  const branches = await page
    .locator(
      `[data-run-id="${search.id}"] > .history-children > .history-branch`,
    )
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.runId));
  assert(branches.includes(related.id) && branches.includes(cited.id));
  await page.locator(".stage-papers li").first().waitFor();
  assert.equal(await page.locator(".stage-papers li").count(), 3);
  await page.screenshot({
    animations: "disabled",
    path: "artifacts/qa/design-history.png",
  });
  report.checks.push(
    "history renders related and cited-by as siblings with the actual three source papers",
  );
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  await api("mutateWorks", {
    projectId,
    ids: sourceIds,
    patch: { screening: "included" },
  });
  await api("mutateWorks", {
    projectId,
    ids: [sourceIds[0]],
    patch: { reading: "reading" },
  });
  await api("mutateWorks", {
    projectId,
    ids: [sourceIds[1]],
    patch: { reading: "read" },
  });
  await page.getByRole("button", { name: /^내 아카이브/ }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".paper-row").length === 3,
  );
  assert.equal(
    await page.getByRole("textbox", { name: "논문 검색", exact: true }).count(),
    0,
  );
  await page
    .getByRole("group", { name: "읽기 상태 필터" })
    .getByRole("button", { name: "읽는 중", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".paper-row").length === 1,
  );
  await page.locator(".paper-main").first().click();
  await page.getByRole("tab", { name: "노트", exact: true }).click();
  await page
    .getByRole("textbox", { name: "문헌 노트" })
    .fill("Design QA note: preserved across inspector tabs.");
  await page.getByRole("tab", { name: "초록", exact: true }).click();
  await page.getByRole("tab", { name: "노트", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "문헌 노트" }).inputValue(),
    "Design QA note: preserved across inspector tabs.",
  );
  await page.waitForFunction(() =>
    document.querySelector(".note-heading")?.textContent?.includes("자동 저장"),
  );
  assert.equal(
    (await api("inspect", { projectId, workId: sourceIds[0] })).state.note,
    "Design QA note: preserved across inspector tabs.",
  );
  await page
    .getByRole("group", { name: "읽기 상태 필터" })
    .getByRole("button", { name: "전체", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".paper-row").length === 3,
  );
  await page.screenshot({
    animations: "disabled",
    path: "artifacts/qa/design-archive.png",
  });
  report.checks.push(
    "archive reading filter uses persisted state and note autosave survives tab changes",
  );
  await page.getByRole("button", { name: "설정 로컬" }).click();
  await page.getByRole("heading", { name: "설정", exact: true }).waitFor();
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.equal(await page.locator(".inspector").count(), 0);
  assert.equal(
    await page.locator(".settings-advanced").first().getAttribute("open"),
    null,
  );
  await page.screenshot({
    animations: "disabled",
    path: "artifacts/qa/design-settings.png",
  });
  await page
    .getByRole("group", { name: "테마", exact: true })
    .getByRole("button", { name: "어둡게", exact: true })
    .click();
  await page.getByRole("button", { name: "설정 저장", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.equal((await api("snapshot")).settings.theme, "dark");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(980, 720),
  );
  await page.waitForFunction(() => innerWidth === 980);
  assert(
    await page
      .getByRole("button", { name: "설정 저장", exact: true })
      .isVisible(),
  );
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  await page.locator(".paper-row").first().waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    animations: "disabled",
    path: "artifacts/qa/design-compact.png",
  });
  report.checks.push(
    "full settings workspace, collapsed advanced controls, saved theme, and 980px layout",
  );
  assert.deepEqual(report.errors, []);
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: "artifacts/qa/design-failure.png" })
      .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await writeFile(
    "artifacts/qa/design-report.json",
    JSON.stringify(report, null, 2),
  );
  await rm(data, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
