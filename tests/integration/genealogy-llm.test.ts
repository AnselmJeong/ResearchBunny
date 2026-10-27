import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Library } from "../../src/service/db/database";
import { GenealogyAI, Meter } from "../../src/service/genealogy/llm";
import { defaultRoutes } from "../../src/shared/genealogy";
import { DEFAULT_AI } from "../../src/service/providers/openai";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
async function library() {
  const root = await mkdtemp(join(tmpdir(), "researchbunny-genealogy-llm-"));
  const db = new Library(root);
  cleanups.push(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return db;
}
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const parse = (value: unknown) => z.object({ answer: z.string().min(2) }).parse(value);
const base = { runId: "run", instruction: "Answer.", input: "{}", schema, parse, signal: new AbortController().signal };

test("each stage route reaches only its own provider and counts usage", async () => {
  const db = await library();
  const seen: string[] = [];
  const ai = new GenealogyAI(db, {
    codex: { async complete(r) { seen.push(`codex:${r.model}:${!!r.outputSchema}`); return '{"answer":"codex"}'; } },
    claude: { async complete(r) { seen.push(`claude:${r.model}:${!!r.outputSchema}`); return '{"answer":"claude"}'; } },
    ollama: { async complete(model, messages, _signal, max, format) { seen.push(`ollama:${model}:${messages[0].role}:${max}:${!!format}`); return '```json\n{"answer":"ollama"}\n```'; } },
  });
  expect(await ai.json({ ...base, route: { provider: "codex", model: "gpt-6.1" } })).toEqual({ answer: "codex" });
  expect(await ai.json({ ...base, route: { provider: "claude", model: "opus" } })).toEqual({ answer: "claude" });
  expect(await ai.json({ ...base, route: { provider: "ollama", model: "gpt-oss:120b" }, maxOutputTokens: 9000 })).toEqual({ answer: "ollama" });
  expect(seen).toEqual(["codex:gpt-6.1:true", "claude:opus:true", "ollama:gpt-oss:120b:system:9000:true"]);
  expect(db.usageSummary().map((u) => u.provider).sort()).toEqual(["claude", "codex", "ollama"]);
});

test("an invalid reply gets one corrective retry that names the problem", async () => {
  const db = await library();
  const instructions: string[] = [];
  const replies = ['{"answer":"x"}', '{"answer":"fixed"}'];
  const ai = new GenealogyAI(db, { codex: { async complete(r) { instructions.push(r.instruction); return replies.shift()!; } } });
  expect(await ai.json({ ...base, route: { provider: "codex", model: "" } })).toEqual({ answer: "fixed" });
  expect(instructions[1]).toContain("previous reply was rejected");
  expect(instructions[1]).toContain("too_small");
});

test("two unusable replies fail as a format error", async () => {
  const db = await library();
  const ai = new GenealogyAI(db, { claude: { async complete() { return "not json"; } } });
  await expect(ai.json({ ...base, route: { provider: "claude", model: "" } })).rejects.toMatchObject({ code: "AI_FORMAT" });
});

test("a spent subscription pauses as a budget error; other failures stay provider errors", async () => {
  const db = await library();
  const limited = new GenealogyAI(db, { claude: { async complete() { throw new Error("Claude 구독 사용 한도에 도달했습니다."); } } });
  await expect(limited.json({ ...base, route: { provider: "claude", model: "" } })).rejects.toMatchObject({ code: "BUDGET" });
  const broken = new GenealogyAI(db, { codex: { async complete() { throw new Error("connection reset"); } } });
  await expect(broken.json({ ...base, route: { provider: "codex", model: "" } })).rejects.toMatchObject({ code: "AI_PROVIDER" });
  const missing = new GenealogyAI(db, {});
  await expect(missing.json({ ...base, route: { provider: "ollama", model: "m" } })).rejects.toMatchObject({ code: "OLLAMA_UNAVAILABLE" });
});

test("the meter stops at the call limit and refuses oversized inputs before any call", async () => {
  const db = await library();
  let calls = 0;
  const ai = new GenealogyAI(db, { codex: { async complete() { calls++; return '{"answer":"ok"}'; } } });
  const meter = new Meter({ maxCalls: 1, maxInputBytesPerCall: 2000 });
  await ai.json({ ...base, route: { provider: "codex", model: "" }, meter });
  await expect(ai.json({ ...base, route: { provider: "codex", model: "" }, meter })).rejects.toMatchObject({ code: "BUDGET" });
  await expect(ai.json({ ...base, input: "x".repeat(5000), route: { provider: "codex", model: "" }, meter: new Meter({ maxCalls: 9, maxInputBytesPerCall: 2000 }) })).rejects.toMatchObject({ code: "AI_INPUT" });
  expect(calls).toBe(1);
});

test("default routes follow the Settings connection and never pick the paid API", () => {
  expect(defaultRoutes({ ...DEFAULT_AI, aiProvider: "codex", codexModel: "gpt-6.1" }).write).toEqual({ provider: "codex", model: "gpt-6.1" });
  expect(defaultRoutes({ ...DEFAULT_AI, aiProvider: "claude", claudeModel: "opus" }).cards).toEqual({ provider: "claude", model: "opus" });
  expect(defaultRoutes({ ...DEFAULT_AI, aiProvider: "openai" }).light).toEqual({ provider: "codex", model: "" });
});
