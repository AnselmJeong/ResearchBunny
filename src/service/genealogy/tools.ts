import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The first executable among the usual install locations; apps opened from Finder see a short PATH. */
export function findTool(name: string, extra: string[] = []): string | null {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    join(homedir(), "bin"),
    ...extra,
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
  ];
  for (const dir of new Set(dirs)) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Next location.
    }
  }
  return null;
}

/** pandoc renders EPUB and PDF; typst is its PDF engine (Quarto bundles one). */
export function genealogyTools() {
  return {
    pandoc: findTool("pandoc", ["/Applications/quarto/bin/tools/aarch64", "/Applications/quarto/bin/tools/x86_64", "/Applications/quarto/bin/tools"]),
    typst: findTool("typst", ["/Applications/quarto/bin/tools/aarch64", "/Applications/quarto/bin/tools/x86_64"]),
  };
}
