import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await mkdir("assets/icon.iconset", { recursive: true });
for (const size of [16, 32, 128, 256, 512])
  for (const scale of [1, 2])
    await sharp("assets/icon.svg")
      .resize(size * scale, size * scale)
      .png()
      .toFile(
        `assets/icon.iconset/icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
      );
execFileSync("/usr/bin/iconutil", [
  "-c",
  "icns",
  "assets/icon.iconset",
  "-o",
  "assets/icon.icns",
]);
