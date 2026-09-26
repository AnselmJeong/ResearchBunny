import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { signAsync } from "@electron/osx-sign";
const app = resolve("out/ResearchBunny-darwin-arm64/ResearchBunny.app");
await signAsync({
  app,
  platform: "darwin",
  identity: "-",
  identityValidation: false,
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  gatekeeperAssess: false,
  optionsForFile: () => ({
    entitlements: resolve("assets/entitlements.plist"),
    hardenedRuntime: false,
    timestamp: "none",
  }),
});
execFileSync(
  "/usr/bin/codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", app],
  { stdio: "inherit" },
);
console.log(
  "Local ad-hoc signature verified; not Developer ID signed or notarized.",
);
