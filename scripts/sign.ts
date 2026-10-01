import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
if (process.platform !== "darwin")
  throw new Error("This release is macOS-only.");
const directory = process.env.ELECTROBUN_BUILD_DIR;
const name = process.env.ELECTROBUN_APP_NAME;
const wrapper = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
const candidates = [
  wrapper,
  directory && name ? join(directory, `${name}.app`) : undefined,
  directory,
];
const target = candidates.find(
  (path): path is string => !!path && path.endsWith(".app") && existsSync(path),
);
if (!target)
  throw new Error(
    `App bundle not found for signing: ${JSON.stringify({ directory, name, wrapper })}`,
  );
// The standard macOS About panel reads this line from the bundle metadata.
const aboutCredit = spawnSync("/usr/bin/plutil", [
  "-replace", "NSHumanReadableCopyright", "-string",
  "developed by Anselm Jeong", join(target, "Contents", "Info.plist"),
], { stdio: "inherit" });
if (aboutCredit.status !== 0) process.exit(1);
const automationUsage = spawnSync("/usr/bin/plutil", [
  "-replace", "NSAppleEventsUsageDescription", "-string",
  "로그인된 Google Chrome에서 논문 원문을 열고 PDF를 다운로드합니다.", join(target, "Contents", "Info.plist"),
], { stdio: "inherit" });
if (automationUsage.status !== 0) process.exit(1);
for (const args of [
  ["--force", "--deep", "--sign", "-", resolve(target)],
  ["--verify", "--deep", "--strict", resolve(target)],
]) {
  const result = spawnSync("/usr/bin/codesign", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
}
console.log(`Verified local ad-hoc signature: ${target}`);
