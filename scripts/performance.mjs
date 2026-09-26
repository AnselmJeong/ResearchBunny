import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "researchbunny-perf-"));
await build({
  entryPoints: ["tests/integration/performance.ts"],
  outfile: "dist/performance.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["better-sqlite3"],
});
const result = spawnSync(require("electron"), ["dist/performance.cjs", root], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});
if (result.status) process.exit(result.status);
const env = { ...process.env, RESEARCHBUNNY_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [resolve(".")], env });
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => document.querySelectorAll(".paper-row").length === 50,
  );
  for (let target = 100; target <= 500; target += 50) {
    await page
      .getByRole("button", { name: "50편 더 표시", exact: true })
      .click();
    await page.waitForFunction(
      (n) => document.querySelectorAll(".paper-row").length === n,
      target,
    );
  }
  await page.getByRole("button", { name: "그래프 보기", exact: true }).click();
  await page.locator(".graph-canvas canvas").first().waitFor();
  await page.getByLabel("500편까지").check();
  await page.waitForFunction(
    () =>
      document.querySelector(".graph-canvas")?._cyreg?.cy?.nodes().length ===
      500,
  );
  const performanceData = await page.evaluate(async () => {
    const cy = document.querySelector(".graph-canvas")._cyreg.cy;
    const times = [];
    let prev = performance.now();
    await new Promise((resolve) => {
      let i = 0;
      const frame = () => {
        const t = performance.now();
        times.push(t - prev);
        prev = t;
        cy.panBy({ x: i % 2 ? 2 : -2, y: 1 });
        if (++i < 90) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    const sorted = times.slice(2).sort((a, b) => a - b);
    const start = performance.now();
    cy.nodes().slice(0, 20).select();
    await new Promise((r) => requestAnimationFrame(r));
    return {
      nodes: cy.nodes().length,
      edges: cy.edges().length,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
      meanFrameMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      selectionFrameMs: performance.now() - start,
    };
  });
  await page.screenshot({ path: "artifacts/qa/graph-500.png" });
  await writeFile(
    "artifacts/qa/performance-graph.json",
    JSON.stringify(performanceData, null, 2),
  );
  console.log(performanceData);
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
