// Compare screening configurations on a project's own decisions without the app.
// The library is copied first (read-only on the original), so nothing in it changes.
// The archive counts as relevant, the trash and 제외 as not relevant.
//
//   OLLAMA_API_KEY=… bun scripts/screen-eval.ts --project <name or id> [--data <library folder>]
//     [--size 40] [--modes decision,two-stage,generative] [--model clef] [--out report.json]
//
// The generative model is the connection chosen in the app's Settings (Codex or
// Claude subscription, or Ollama Cloud with OLLAMA_API_KEY).
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import Database from "../src/service/db/sqlite";
import { Library } from "../src/service/db/database";
import { DEFAULT_AI, type AIConfig } from "../src/service/providers/openai";
import { OllamaCloud } from "../src/service/providers/ollama";
import { CodexClient } from "../src/service/codex/client";
import { ClaudeClient } from "../src/service/claude/client";
import { GenealogyAI } from "../src/service/genealogy/llm";
import { defaultRoutes } from "../src/shared/genealogy";
import { DecisionClient } from "../src/service/screening/decision";
import { ScreeningStore } from "../src/service/screening/store";
import { evaluateScreening, evaluationSet } from "../src/service/screening/evaluate";
import type { ScreeningMode } from "../src/shared/screening";

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const data = resolve(arg("data") || join(homedir(), "Library/Application Support/ResearchBunny/library"));
const source = join(data, "library.sqlite");
if (!existsSync(source)) throw new Error(`No library at ${source}`);
const projectArg = arg("project");
if (!projectArg) throw new Error("--project <name or id> is required");
const size = Number(arg("size") || 40);
const modes = (arg("modes") || "decision,two-stage,generative").split(",").map((m) => m.trim()) as ScreeningMode[];

const scratch = mkdtempSync(join(tmpdir(), "researchbunny-screen-eval-"));
mkdirSync(join(scratch, "library"));
const original = new Database(source, { readonly: true });
original.query("VACUUM INTO ?").run(join(scratch, "library", "library.sqlite"));
original.close();
const db = new Library(join(scratch, "library"));
const codex = new CodexClient();
const claude = new ClaudeClient();
try {
  const project = db.projects().find((p) => p.id === projectArg || p.name === projectArg);
  if (!project) throw new Error(`No project named ${projectArg}. Projects: ${db.projects().map((p) => p.name).join(", ")}`);
  const settings = { ...DEFAULT_AI, ...db.pref<Partial<AIConfig>>("ai") } as AIConfig;
  const key = () => process.env.OLLAMA_API_KEY;
  const store = new ScreeningStore(db.db, () => project.question);
  const profile = { ...store.profile(project.id), ...(arg("model") ? { decisionModel: arg("model")! } : {}) };
  const set = evaluationSet(db.db, project.id, size);
  console.log(`project ${project.name} · criteria v${profile.version} (${profile.include.length} include, ${profile.exclude.length} exclude) · purpose ${profile.purpose}`);
  console.log(`evaluation set: ${set.relevant.length} archive papers, ${set.irrelevant.length} trashed or excluded`);
  const route = defaultRoutes(settings).light;
  console.log(`decision model ${profile.decisionModel}${key() ? "" : " (no OLLAMA_API_KEY: skipped)"} · generative ${route.provider}${settings.aiEnabled ? "" : " (AI is off in Settings)"}`);
  const usable = modes.filter((m) => (m === "generative" ? true : !!key()));
  const report = await evaluateScreening(
    {
      decision: new DecisionClient(key),
      ai: new GenealogyAI(db, { codex, claude, ollama: new OllamaCloud(key) }, () => ({ codex: settings.codexModel, claude: settings.claudeModel, ollama: settings.ollamaModel })),
      route,
      runId: "screen-eval",
    },
    {
      profile,
      relevant: set.relevant,
      irrelevant: set.irrelevant,
      modes: usable,
      examples: store.examples(project.id, 16),
      signal: AbortSignal.timeout(60 * 60 * 1000),
      onProgress: (message) => process.stdout.write(`\r${message.padEnd(70)}`),
    },
  );
  process.stdout.write("\n\n");
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log("configuration            missed (rate)   caught/irrelevant  보류   included/relevant  calls (dec/gen)  tokens   time");
  for (const s of report.scores)
    console.log(
      s.error
        ? `${s.label.padEnd(24)} failed: ${s.error}`
        : `${s.label.padEnd(24)} ${`${s.missed} (${pct(s.missRate)})`.padEnd(15)} ${`${s.caught}/${s.irrelevant}`.padEnd(18)} ${String(s.maybe).padEnd(6)} ${`${s.included}/${s.relevant}`.padEnd(18)} ${`${s.calls.decision}/${s.calls.generative}`.padEnd(16)} ${String(s.inputTokens).padEnd(8)} ${(s.elapsedMs / 1000).toFixed(0)}s ${s.passed ? "PASS" : "FAIL"}`,
    );
  console.log(`\nrecommended: ${report.recommended ?? "none passes (missed relevant papers must stay at or below 5%)"}`);
  const out = arg("out");
  if (out) writeFileSync(resolve(out), JSON.stringify(report, null, 2));
} finally {
  codex.close();
  claude.close();
  db.close();
  rmSync(scratch, { recursive: true, force: true });
}
