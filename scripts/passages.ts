// Index the shelf's passages without the app: reads the library read-only and
// writes passages.sqlite beside it. The app picks the file up and continues
// incrementally; while this runs, the app's own passage indexing waits.
//
//   bun scripts/passages.ts [--data <library folder>] [--out <passages.sqlite>] [--limit N] [--worker <pdf-worker.cjs>]
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import Database from "../src/service/db/sqlite";
import { OllamaLocal } from "../src/service/providers/ollama-local";
import { PassageIndexer } from "../src/service/passages/indexer";
import { PASSAGE_FILE, PassageStore } from "../src/service/passages/store";
import { DEFAULT_OLLAMA_URL, type ShelfConfig } from "../src/shared/shelf";
import type { PassageJob } from "../src/shared/passages";

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const data = resolve(arg("data") || join(homedir(), "Library/Application Support/ResearchBunny/library"));
const libraryPath = join(data, "library.sqlite");
if (!existsSync(libraryPath)) throw new Error(`No library at ${libraryPath}`);
const out = resolve(arg("out") || join(data, PASSAGE_FILE));
const limit = arg("limit") ? Number(arg("limit")) : undefined;
// A long pass can use a copy of the worker so rebuilding the app meanwhile does not swap it mid-run.
const worker = resolve(arg("worker") || resolve(import.meta.dir, "../dist/pdf-worker.cjs"));
if (!existsSync(worker)) throw new Error("Run `bun scripts/build.ts` first: dist/pdf-worker.cjs is missing.");

const library = new Database(libraryPath, { readonly: true });
library.pragma("busy_timeout = 10000");
const config = JSON.parse((library.prepare("SELECT data FROM preferences WHERE key='shelf'").get() as { data: string } | undefined)?.data || "null") as ShelfConfig | null;
if (!config) throw new Error("The library has no shelf configured.");
const store = new PassageStore(out);
const ollama = new OllamaLocal(() => config.ollamaUrl || DEFAULT_OLLAMA_URL);

const started = Date.now();
const line = (job: PassageJob) => {
  const left = job.passages.total - job.passages.done;
  const eta = job.rate ? `${(left / job.rate / 3600).toFixed(1)} h left` : "";
  return `${new Date().toISOString()} ${job.state} · PDFs ${job.docs.done}/${job.docs.total} · embedded ${job.passages.done}/${job.passages.total}${job.rate ? ` · ${job.rate}/s · ${eta}` : ""} · ${job.message}`;
};
let last = 0;
const indexer = new PassageIndexer(library, store, worker, ollama, {
  model: () => config.model,
  limit,
  onJob: (job) => {
    if (Date.now() - last < 30000 && job.state === "running") return;
    last = Date.now();
    console.log(line(job));
  },
});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log("stopping…");
  indexer.stop();
  await indexer.wait();
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

console.log(`library ${libraryPath} (read-only)\npassages ${out}\nmodel ${config.model}${limit ? `\nlimit ${limit} PDFs` : ""}`);
await indexer.run();
console.log(line(indexer.job));
console.log(`finished in ${((Date.now() - started) / 60000).toFixed(1)} min`);
store.close();
library.close();
