import { build as bundle } from "esbuild";
import { build } from "vite";
import react from "@vitejs/plugin-react";
await bundle({
  entryPoints: {
    main: "src/main/index.ts",
    preload: "src/preload/index.ts",
    service: "src/service/index.ts",
    "pdf-worker": "src/workers/pdf.ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  external: [
    "electron",
    "better-sqlite3",
    "pdfjs-dist",
    "@citation-js/core",
    "@citation-js/plugin-bibtex",
  ],
  sourcemap: true,
  target: "node22",
});
await build({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
