import { execFileSync } from "node:child_process";
import { mkdir, rm, symlink, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const app = resolve("out/ResearchBunny-darwin-arm64/ResearchBunny.app");
const stage = resolve("out/dmg-stage");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir("out/make", { recursive: true });
execFileSync("/usr/bin/ditto", [app, join(stage, "ResearchBunny.app")]);
await symlink("/Applications", join(stage, "Applications"));
const target = resolve(
  `out/make/ResearchBunny-${packageJson.version}-arm64.dmg`,
);
execFileSync(
  "/usr/bin/hdiutil",
  [
    "create",
    "-volname",
    "ResearchBunny",
    "-srcfolder",
    stage,
    "-format",
    "UDZO",
    "-ov",
    target,
  ],
  { stdio: "inherit" },
);
execFileSync("/usr/bin/hdiutil", ["verify", target], { stdio: "inherit" });
await writeFile(
  target + ".sha256",
  createHash("sha256")
    .update(await readFile(target))
    .digest("hex") +
    "  " +
    target.split("/").at(-1) +
    "\n",
);
await rm(stage, { recursive: true, force: true });
console.log(target);
