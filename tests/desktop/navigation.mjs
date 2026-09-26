import { _electron as electron } from "playwright";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const data = await mkdtemp(join(tmpdir(), "researchbunny-navigation-"));
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
const selectedTitles = async () => {
  await page.locator(".paper-row").first().waitFor();
  return page
    .locator('.paper-list input[type="checkbox"]:checked')
    .evaluateAll((items) =>
      items.map((i) => i.getAttribute("aria-label")).sort(),
    );
};
async function persistedSelection(projectId, count) {
  return pollSnapshot(projectId, (s) => {
    const h = s.ui.navigation;
    const view = h?.views[h.keys[h.index]];
    return view?.selected.length === count ? view : false;
  });
}

try {
  await launch();
  const projectId = (await api("snapshot")).projects[0].id;
  await page
    .getByRole("textbox", { name: "논문 검색", exact: true })
    .fill("navigation research");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  const search = await waitRun("search");
  await page.waitForFunction(
    () => document.querySelectorAll(".paper-row").length === 10,
  );
  const boxes = page.locator('.paper-row input[type="checkbox"]');
  for (let i = 0; i < 3; i++) await boxes.nth(i).check();
  await page.getByRole("combobox", { name: "목록 정렬" }).selectOption("year");
  await page
    .getByRole("textbox", { name: "현재 문헌에서 찾기" })
    .fill("Navigation");
  const root = await persistedSelection(projectId, 3);
  const expected = await selectedTitles();
  assert.equal(expected.length, 3);
  await page
    .getByRole("button", { name: "관련 문헌 찾기", exact: true })
    .click();
  await page
    .locator(".discovery-popover")
    .getByRole("button", { name: "관련 논문", exact: true })
    .click();
  const related = await waitRun("related");
  assert.equal(related.parentId, search.id);
  assert.deepEqual([...related.inputIds].sort(), [...root.selected].sort());
  await boxes.first().check();
  const child = await persistedSelection(projectId, 1);
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".selection-bar")?.textContent?.includes("3편 선택"),
  );
  assert.deepEqual(await selectedTitles(), expected);
  assert.equal(
    await page
      .getByRole("textbox", { name: "현재 문헌에서 찾기" })
      .inputValue(),
    "Navigation",
  );
  assert.equal(
    await page.getByRole("combobox", { name: "목록 정렬" }).inputValue(),
    "year",
  );
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  assert.deepEqual(
    (await persistedSelection(projectId, 1)).selected,
    child.selected,
  );
  await page
    .getByRole("navigation", { name: "탐색 경로" })
    .getByRole("button")
    .first()
    .click();
  await persistedSelection(projectId, 3);
  // Clicking the current stage must not overwrite newer checkbox changes.
  await boxes.first().uncheck();
  const beforeCurrentClick = await selectedTitles();
  await page
    .getByRole("navigation", { name: "탐색 경로" })
    .getByRole("button")
    .first()
    .click();
  assert.deepEqual(await selectedTitles(), beforeCurrentClick);
  await boxes.first().check();
  await page
    .getByRole("button", { name: "관련 문헌 찾기", exact: true })
    .click();
  await page
    .locator(".discovery-popover")
    .getByRole("button", { name: "후속 인용", exact: true })
    .click();
  const cited = await waitRun("citedBy");
  assert.equal(cited.parentId, search.id);
  assert.deepEqual([...cited.inputIds].sort(), [...root.selected].sort());
  assert((await api("snapshot")).runs.some((r) => r.id === related.id));
  await page.locator(".recent-run").nth(1).click();
  assert.deepEqual(
    (await persistedSelection(projectId, 1)).selected,
    child.selected,
  );
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  await persistedSelection(projectId, 0);
  report.checks.push(
    "10 search results → select 3 → related → back/forward → ancestor → cited-by on the same 3; original branch retained",
  );
  await page
    .getByRole("button", { name: "관련 문헌 찾기", exact: true })
    .click();
  const tooltipButton = page.locator(".discovery-popover").getByRole("button", {
    name: "후속 인용",
    exact: true,
  });
  await tooltipButton.hover();
  await page.getByRole("tooltip").waitFor();
  assert.match(
    await page.getByRole("tooltip").innerText(),
    /선택한 논문을 인용한/,
  );
  assert.equal(
    await page.getByRole("tooltip").evaluate((e) => e.matches(":popover-open")),
    true,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("tooltip").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "논문 검색", exact: true }).focus();
  await page.getByRole("button", { name: "이전 단계", exact: true }).focus();
  await page.getByRole("tooltip").waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "이전 단계", exact: true })
      .getAttribute("aria-describedby"),
    "bunny-help",
  );
  report.checks.push(
    "hover help (including disabled controls), keyboard focus, accessible description, Escape dismissal",
  );
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  await persistedSelection(projectId, 3);
  await page.screenshot({ path: "artifacts/qa/navigation-light.png" });
  await app.close();
  await launch();
  assert.deepEqual(
    [...(await persistedSelection(projectId, 3)).selected].sort(),
    [...root.selected].sort(),
  );
  assert.equal(
    await page.getByRole("combobox", { name: "목록 정렬" }).inputValue(),
    "year",
  );
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  await persistedSelection(projectId, 0);
  report.checks.push(
    "application restart restores selected papers, sort order and forward history",
  );
  const p2 = await api("createProject", {
    name: "Separate project",
    question: "",
  });
  await page
    .getByRole("combobox", { name: "프로젝트", exact: true })
    .selectOption(p2.id);
  await page.waitForFunction(() =>
    document
      .querySelector(".workspace-heading")
      ?.textContent?.includes("내 아카이브"),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "이전 단계", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("combobox", { name: "프로젝트", exact: true })
    .selectOption(projectId);
  await page.getByRole("navigation", { name: "탐색 경로" }).waitFor();
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  assert.deepEqual(
    [...(await persistedSelection(projectId, 3)).selected].sort(),
    [...root.selected].sort(),
  );
  report.checks.push(
    "project navigation histories are isolated and restored on project switch",
  );
  await page.getByRole("button", { name: "연도 보기", exact: true }).click();
  await page.locator(".graph-canvas canvas").first().waitFor();
  await page.getByRole("button", { name: /^내 아카이브/ }).click();
  await page.getByRole("button", { name: "이전 단계", exact: true }).click();
  await page.locator(".graph-canvas canvas").first().waitFor();
  assert.match(
    await page.getByRole("button", { name: "연도 보기" }).getAttribute("class"),
    /active/,
  );
  assert.deepEqual(
    [...(await persistedSelection(projectId, 3)).selected].sort(),
    [...root.selected].sort(),
  );
  await page.getByRole("button", { name: "목록 보기", exact: true }).click();
  report.checks.push("timeline view and selection survive library navigation");
  await page
    .getByRole("button", { name: "관련 문헌 찾기", exact: true })
    .click();
  await page
    .locator(".discovery-popover")
    .getByRole("button", { name: "관련 논문", exact: true })
    .click();
  await waitRun("related", related.id);
  await page.locator(".paper-row").first().waitFor();
  await page.screenshot({ path: "artifacts/qa/navigation-light.png" });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page
    .getByRole("button", { name: "관련 문헌 찾기", exact: true })
    .click();
  await page
    .locator(".discovery-popover")
    .getByRole("button", { name: "관련 논문", exact: true })
    .hover();
  await page.getByRole("tooltip").waitFor();
  await page.screenshot({ path: "artifacts/qa/navigation-dark.png" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "설정 로컬" }).click();
  await page
    .getByRole("button", { name: "연결 확인", exact: true })
    .first()
    .hover();
  await page.getByRole("tooltip").waitFor();
  assert.match(await page.getByRole("tooltip").innerText(), /공급자에 연결/);
  assert.equal(
    await page.getByRole("tooltip").evaluate((e) => e.matches(":popover-open")),
    true,
  );
  report.checks.push("help remains visible in settings workspace");
  assert.deepEqual(report.errors, []);
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: "artifacts/qa/navigation-failure.png" })
      .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await writeFile(
    "artifacts/qa/navigation-report.json",
    JSON.stringify(report, null, 2),
  );
  await rm(data, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
