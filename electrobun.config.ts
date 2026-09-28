import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json";
const qaRoot = process.env.RESEARCHBUNNY_BUILD_QA_ROOT;
export default {
  app: {
    name: qaRoot ? "ResearchBunny-QA" : "ResearchBunny",
    identifier: qaRoot
      ? "app.researchbunny.desktop.qa"
      : "app.researchbunny.desktop",
    version: pkg.version,
  },
  build: {
    artifactFolder: "out/electrobun",
    bun: {
      entrypoint: "src/main/index.ts",
      minify: true,
      ...(qaRoot
        ? {
            define: {
              "process.env.RESEARCHBUNNY_DATA_DIR": JSON.stringify(qaRoot),
              "process.env.RESEARCHBUNNY_TEST": '"1"',
            },
          }
        : {}),
    },
    bunVersion: "1.3.8",
    copy: {
      "dist/renderer": "views/main",
      "dist/runtime": "runtime",
      "dist/native": "native",
    },
    mac: {
      codesign: true,
      bundleCEF: false,
      bundleWGPU: false,
      defaultRenderer: "native",
      icons: "assets/icon.iconset",
    },
  },
  scripts: { postBuild: "scripts/sign.ts", postWrap: "scripts/sign.ts" },
  release: { generatePatch: false },
  runtime: { exitOnLastWindowClosed: true },
} satisfies ElectrobunConfig;
