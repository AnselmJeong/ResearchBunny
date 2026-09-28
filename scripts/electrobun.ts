import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const cli = resolve("node_modules/electrobun/bin/electrobun");
if (!existsSync(cli)) {
  // The npm launcher downloads the pinned official CLI on first invocation.
  const bootstrap = spawnSync(
    process.execPath,
    ["node_modules/electrobun/bin/electrobun.cjs", "--help"],
    { stdio: "inherit" },
  );
  if (!existsSync(cli)) process.exit(bootstrap.status || 1);
}
if (
  process.platform === "darwin" &&
  spawnSync("/usr/bin/codesign", ["--verify", cli]).status !== 0
) {
  const sign = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", cli], {
    stdio: "inherit",
  });
  if (sign.status !== 0) process.exit(1);
}
const child = Bun.spawn([cli, ...process.argv.slice(2)], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
  env: {
    ...process.env,
    ELECTROBUN_DEVELOPER_ID: process.env.ELECTROBUN_DEVELOPER_ID ?? "-",
  },
});
process.exit(await child.exited);
