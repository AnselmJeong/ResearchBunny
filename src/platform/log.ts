import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 1024 * 1024;
/** Key-like values never reach the log: provider keys, bearer tokens, key/token/secret assignments. */
export function redact(text: string) {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "$1-***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/((?:api[_-]?key|token|secret|password|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',&}]{6,}/gi, "$1***")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
}
const describe = (detail: unknown) =>
  detail instanceof Error ? detail.stack || `${detail.name}: ${detail.message}` : typeof detail === "string" ? detail : JSON.stringify(detail);

export type Log = (level: "info" | "warn" | "error", message: string, detail?: unknown) => void;
/**
 * A small log under the app's data folder: `logs/researchbunny.log`, with one
 * previous file kept. Both processes append whole lines to it. Writing never
 * throws; a log that cannot be written must not take the app down with it.
 */
export function createLog(dataRoot: string | undefined, source: string): Log {
  if (!dataRoot) return () => {};
  const dir = join(dataRoot, "logs");
  const path = join(dir, "researchbunny.log");
  return (level, message, detail) => {
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(path).size > MAX_BYTES) renameSync(path, path + ".1");
      } catch {
        /* No log yet. */
      }
      const body = detail === undefined ? message : `${message}\n${describe(detail)}`;
      appendFileSync(path, `${new Date().toISOString()} ${level.toUpperCase()} [${source}] ${redact(body).replace(/\n/g, "\n    ")}\n`, { mode: 0o600 });
    } catch {
      /* Disk full or folder gone. */
    }
  };
}
