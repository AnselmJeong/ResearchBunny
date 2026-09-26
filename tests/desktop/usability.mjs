import { _electron as electron } from "playwright";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(join(tmpdir(), "researchbunny-usability-"));
const executablePath = process.env.RESEARCHBUNNY_APP;
const env = {
  ...process.env,
  RESEARCHBUNNY_DATA_DIR: root,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  await writeFile(join(root, "credentials.json"), "invalid credential file");
  app = await electron.launch({
    ...(executablePath
      ? { executablePath, args: [] }
      : { args: [resolve(".")] }),
    env,
  });
  const page = await app.firstWindow();
  const api = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.bunny[method](args), {
      method,
      args,
    });
  const snapshot = await api("snapshot");
  await api("manualWork", {
    projectId: snapshot.projects[0].id,
    metadata: {
      title:
        "A very long scientific paper title about the relationship between neural systems and social cognition — ".repeat(
          3,
        ),
      authors: [],
      year: null,
    },
  });
  await page.locator(".paper-row").waitFor();
  await page.keyboard.press("Meta+k");
  assert.equal(
    await page
      .getByRole("textbox", { name: "논문 검색", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.locator(".workspace-heading h1").click();
  await page.keyboard.press("Meta+a");
  await page.getByText("1편 선택", { exact: true }).waitFor();
  await page.keyboard.press("Meta+s");
  await page.keyboard.press("Meta+e");
  await page.getByRole("dialog").waitFor();
  assert(
    await page
      .getByRole("button", { name: "파일 저장", exact: true })
      .isVisible(),
  );
  await page.keyboard.press("Escape");
  await api("saveSettings", { ...snapshot.settings, theme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1100, 760),
  );
  await page.locator(".paper-main").click();
  await page.locator(".inspector h2").waitFor();
  await page.waitForFunction(() => innerWidth === 1100);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "artifacts/qa/dark-compact.png" });
  await page.getByRole("button", { name: "그래프 보기", exact: true }).click();
  await page.getByLabel("유사 관계", { exact: true }).check();
  await page.screenshot({ path: "artifacts/qa/dark-graph.png" });
  const report = {
    checks: [
      "unreadable credentials do not block local library",
      "keyboard search focus, select, save, export dialog",
      "long title, unknown author and year",
      "1100 by 760 window without document overflow",
      "dark list, graph and similarity toggle",
    ],
  };
  await writeFile(
    "artifacts/qa/usability-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
