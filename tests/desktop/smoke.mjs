import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const workspace = resolve(".");
const data =
  process.env.RESEARCHBUNNY_TEST_DATA ||
  (await mkdtemp(join(tmpdir(), "researchbunny-desktop-")));
const artifact = process.env.RESEARCHBUNNY_APP;
await mkdir("artifacts/qa", { recursive: true });
const errors = [];
const report = {
  artifact: artifact || "development",
  checks: [],
  dataPath: data,
};
let app, page;
const launch = async () => {
  const env = {
    ...process.env,
    RESEARCHBUNNY_DATA_DIR: data,
    ...(artifact ? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    ...(artifact
      ? { executablePath: artifact, args: [] }
      : { args: [workspace] }),
    env,
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page
    .getByRole("heading", { name: "내 아카이브", exact: false })
    .waitFor({ timeout: 30000 });
};
const api = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.bunny[method](args), {
    method,
    args,
  });
try {
  await launch();
  await page.screenshot({ path: "artifacts/qa/empty-workspace.png" });
  assert(await page.getByText("첫 문헌부터 시작하세요.").isVisible());
  report.checks.push("empty workspace");
  await page
    .getByRole("button", { name: "문헌 직접 등록", exact: true })
    .first()
    .click();
  await page
    .getByLabel("제목", { exact: true })
    .fill("Interoception and social cognition");
  await page
    .getByLabel("저자 (한 줄에 한 명, 성, 이름)")
    .fill("Lee, Alice\nKim, Bob");
  await page.getByLabel("연도", { exact: true }).fill("2024");
  await page.getByLabel("DOI", { exact: true }).fill("10.9999/desktop-fixture");
  await page.getByRole("button", { name: "문헌 저장", exact: true }).click();
  await page
    .getByRole("heading", {
      name: "Interoception and social cognition",
      exact: true,
    })
    .first()
    .waitFor();
  await page.getByRole("tab", { name: "노트", exact: true }).click();
  await page
    .getByRole("textbox", { name: "문헌 노트" })
    .fill("Persistent private research note");
  await page.waitForFunction(() =>
    document.querySelector(".note-heading")?.textContent?.includes("자동 저장"),
  );
  report.checks.push("manual paper and autosaved note");
  const snapshot = await api("snapshot");
  const projectId = snapshot.projects[0].id;
  const first = (
    await api("list", {
      projectId,
      scope: "archive",
      filters: {
        strictness: "balanced",
        relevance: false,
        minCitations: 0,
        yearFrom: null,
        yearTo: null,
        unknownYear: true,
        types: [],
        include: "",
        exclude: "",
        minShared: 2,
        hasAbstract: false,
        hasPdf: false,
        openAccess: false,
        hideSaved: false,
        hideExcluded: true,
        hideRetracted: true,
      },
    })
  ).works[0];
  await page
    .getByRole("button", { name: "문헌 가져오기", exact: true })
    .first()
    .click();
  await page
    .locator(".bib-input")
    .fill(
      "@article{fixture2,title={Social cognition foundation},author={{World Health Organization}},year={2020},doi={10.9999/fixture2},custom={preserved}}\n@article{fixture3,title={A recent interoception study},author={Chen, Li},year={2025},doi={10.9999/fixture3}}",
    );
  await page
    .getByRole("button", { name: "가져오기 미리보기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "확인된 문헌 가져오기", exact: true })
    .click();
  await page.getByText("신규 2편 · 기존 연결 0편 · 실패 0건").waitFor();
  await page.getByRole("button", { name: "완료", exact: true }).click();
  report.checks.push("BibTeX preview and native UI import");
  await page.waitForFunction(
    () => document.querySelectorAll(".paper-row").length === 2,
  );
  await page
    .getByRole("checkbox", { name: "이 페이지 전체 선택", exact: true })
    .check();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await page.getByText("2편을 저장했습니다.", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: /내 아카이브/ })
    .first()
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll(".paper-row").length === 3,
  );
  await page
    .getByRole("checkbox", { name: "이 페이지 전체 선택", exact: true })
    .check();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "seed", exact: true })
    .click();
  await page
    .getByRole("button", { name: "관심 기준 저장", exact: true })
    .click();
  await page.getByText("3편 고정", { exact: true }).waitFor();
  report.checks.push("multi-select archive and frozen seeds");
  await page.getByRole("button", { name: "그래프 보기", exact: true }).click();
  await page.locator(".graph-canvas canvas").first().waitFor();
  await page.screenshot({ path: "artifacts/qa/graph.png" });
  await page.getByRole("button", { name: "연도 보기", exact: true }).click();
  await page.locator(".year-legend").waitFor();
  await page.getByRole("button", { name: "목록 보기", exact: true }).click();
  report.checks.push("graph and year view");
  // Export through native save dialog, with the path supplied by the automated test.
  const exportPath = join(data, "selected.bib");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exportPath);
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "내보내기", exact: true })
    .click();
  await page.getByRole("button", { name: "파일 저장", exact: true }).click();
  await page.getByText(/3편 내보냄/).waitFor();
  const exported = await readFile(exportPath, "utf8");
  assert.equal((exported.match(/^@/gm) || []).length, 3);
  assert(!exported.includes("Persistent private"));
  report.checks.push("selected BibTeX export excludes private notes");
  const security = await page.evaluate(() => ({
    node: typeof window.require,
    process: typeof window.process,
    invoke: typeof window.bunny.invoke,
    keys: Object.keys(window.bunny),
  }));
  assert.equal(security.node, "undefined");
  assert.equal(security.process, "undefined");
  assert.equal(security.invoke, "undefined");
  report.checks.push("sandboxed renderer API");
  await page.screenshot({ path: "artifacts/qa/library.png" });
  await app.close();
  app = null;
  await launch();
  const restored = await api("inspect", { projectId, workId: first.id });
  assert.equal(restored.state.note, "Persistent private research note");
  const after = await api("snapshot", { projectId });
  assert.equal(after.seeds.ids.length, 3);
  report.checks.push("real application restart retains notes and seeds");
  const sourcePdf = join(data, "synthetic-local.pdf");
  await writeFile(
    sourcePdf,
    await readFile(resolve("tests/fixtures/synthetic-local.pdf")),
  );
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const originalHash = hash(await readFile(sourcePdf));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, sourcePdf);
  const pdfRun = await api("choosePdf", { projectId, mode: "managed" });
  const waitRun = async (id) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const run = (await api("snapshot", { projectId })).runs.find(
        (r) => r.id === id,
      );
      if (run && !["running", "queued"].includes(run.status)) {
        assert.equal(run.status, "completed", run.message);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("PDF job timed out");
  };
  await waitRun(pdfRun.id);
  const pdfList = await api("list", {
    projectId,
    scope: "run",
    scopeId: pdfRun.id,
    filters: pdfRun.filters,
  });
  assert.equal(
    pdfList.works.length,
    1,
    JSON.stringify(await api("importItems", { runId: pdfRun.id })),
  );
  assert.equal(pdfList.works[0].title, "Packaged PDF extraction fixture");
  let attachment = (
    await api("attachments", { workId: pdfList.works[0].id })
  )[0];
  assert.equal(attachment.hash, originalHash);
  assert.equal(hash(await readFile(sourcePdf)), originalHash);
  const duplicatePdf = await api("choosePdf", { projectId, mode: "managed" });
  await waitRun(duplicatePdf.id);
  assert.equal(
    (await api("attachments", { workId: pdfList.works[0].id })).length,
    1,
  );
  report.checks.push(
    "packaged PDF worker, duplicate import and original hash preservation",
  );
  const backupPath = join(data, "qa-backup.researchbunny");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, backupPath);
  const backup = await api("backup", {
    includeAttachments: true,
    includeLinked: true,
  });
  assert.deepEqual(backup.missing, []);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, backupPath);
  const restore = await api("restoreBackup");
  assert.notEqual(restore.path, snapshot.settings.dataPath);
  assert.deepEqual(restore.missing, []);
  assert.equal(
    (await api("inspect", { projectId, workId: first.id })).state.note,
    "Persistent private research note",
  );
  attachment = (await api("attachments", { workId: pdfList.works[0].id }))[0];
  assert.equal(hash(await readFile(attachment.path)), originalHash);
  report.checks.push(
    "native backup/restore retains notes, seeds and attachment hashes",
  );
  const servicePid = await app.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((m) => m.name === "ResearchBunny Library")?.pid,
  );
  assert(servicePid);
  process.kill(servicePid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 1300));
  for (let i = 0; i < 100; i++) {
    try {
      await api("snapshot");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.equal(
    (await api("inspect", { projectId, workId: first.id })).state.note,
    "Persistent private research note",
  );
  report.checks.push("utility process crash recovery preserves committed data");
  await assert.rejects(api("importDropped", { projectId, paths: [sourcePdf] }));
  report.checks.push("renderer cannot import an unapproved local path");
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push("no renderer exceptions");
  await writeFile(
    "artifacts/qa/desktop-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    await page.screenshot({ path: "artifacts/qa/failure.png" }).catch(() => {});
  console.error(error);
  console.error("Renderer errors:", errors);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  if (!process.env.RESEARCHBUNNY_TEST_DATA)
    await rm(data, { recursive: true, force: true });
}
