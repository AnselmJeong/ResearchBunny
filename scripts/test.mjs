import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await build({
  entryPoints: ["tests/integration/run.ts"],
  outfile: "dist/integration-tests.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: [
    "better-sqlite3",
    "@citation-js/core",
    "@citation-js/plugin-bibtex",
    "pdfjs-dist",
  ],
});
const result = spawnSync(
  require("electron"),
  ["--test", "dist/integration-tests.cjs"],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" },
);
process.exit(result.status ?? 1);
