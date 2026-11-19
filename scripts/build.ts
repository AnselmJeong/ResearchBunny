import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chmod, cp, mkdir, stat, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await rm("dist/native", { recursive: true, force: true });
await mkdir("dist/native", { recursive: true });
for (const args of [
  [
    "-O",
    "src/native/platform.swift",
    "-o",
    "dist/native/researchbunny-platform",
  ],
  [
    "-O",
    "-emit-library",
    "src/native/dialogs.swift",
    "-o",
    "dist/native/libResearchBunnyDialogs.dylib",
  ],
]) {
  const compile = spawnSync("/usr/bin/swiftc", args, { stdio: "inherit" });
  if (compile.status !== 0) process.exit(1);
}
await build({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    target: "safari17",
    chunkSizeWarningLimit: 1200,
  },
});
for (const [source, name] of [
  ["src/service/index.ts", "service.js"],
  ["src/workers/pdf.ts", "pdf-worker.cjs"],
  // The read-only MCP connector ScholarPen and coding agents start; see docs/connector.md.
  ["src/connector/index.ts", "connector.js"],
]) {
  const result = await Bun.build({
    entrypoints: [source],
    outdir: "dist/runtime",
    naming: name,
    target: "bun",
    format: name.endsWith("cjs") ? "cjs" : "esm",
    external: ["pdfjs-dist", "@napi-rs/canvas"],
  });
  if (!result.success) throw new Error(result.logs.join("\n"));
}
// The connector runs on the bun inside the app bundle (Contents/MacOS/bun), or on the bun in PATH in a checkout.
await Bun.write(
  "dist/runtime/researchbunny-connector",
  `#!/bin/sh
# ResearchBunny connector: a read-only MCP server on stdio. See docs/connector.md.
here="$(cd "$(dirname "$0")" && pwd)"
bun="$here/../../../MacOS/bun"
[ -x "$bun" ] || bun="$(command -v bun)"
[ -n "$bun" ] || { echo "researchbunny-connector: bun not found" >&2; exit 1; }
exec "$bun" "$here/connector.js" "$@"
`,
);
await chmod("dist/runtime/researchbunny-connector", 0o755);
// Tests and the packaged process use identical worker bytes.
await cp("dist/runtime/pdf-worker.cjs", "dist/pdf-worker.cjs");
await rm("dist/runtime/node_modules", { recursive: true, force: true });
for (const name of [
  "@napi-rs/canvas",
  `@napi-rs/canvas-darwin-${process.arch}`,
]) {
  if (!(await stat(`node_modules/${name}`).catch(() => null)))
    throw new Error(`Missing PDF dependency: ${name}`);
  await cp(`node_modules/${name}`, `dist/runtime/node_modules/${name}`, {
    recursive: true,
  });
}
for (const file of [
  "package.json",
  "LICENSE",
  "legacy/build/pdf.mjs",
  "legacy/build/pdf.worker.mjs",
  "standard_fonts",
  "cmaps",
  "wasm",
  "iccs",
]) {
  const target = `dist/runtime/node_modules/pdfjs-dist/${file}`;
  await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await cp(`node_modules/pdfjs-dist/${file}`, target, { recursive: true });
}
