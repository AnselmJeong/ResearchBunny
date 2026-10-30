import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeClient, jsonReply } from "../../src/service/claude/client";
import { claudeEnvironment } from "../../src/service/claude/process";
import { ChatProvider } from "../../src/service/chat/provider";
import { DEFAULT_AI } from "../../src/service/providers/openai";
import { Service } from "../../src/service/service";
import { CodexClient } from "../../src/service/codex/client";
import { schemas } from "../../src/shared/contracts";
import { DEFAULT_FILTERS, type Run } from "../../src/shared/types";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
async function fixture(scenario: string, timeoutMs = 1500) {
  const home = await mkdtemp(join(tmpdir(), "researchbunny-claude-test-"));
  const log = join(home, "requests.jsonl");
  const client = new ClaudeClient({
    home,
    command: [process.execPath, resolve("tests/fixtures/claude/cli.ts"), scenario, log],
    timeoutMs,
  });
  cleanups.push(async () => {
    client.close();
    await Bun.sleep(50);
    await rm(home, { recursive: true, force: true });
  });
  const requests = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  return { client, home, requests };
}
const request = { model: "opus", instruction: "Answer briefly.", input: "synthetic question" };
async function collect(stream: AsyncIterable<string>) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}
const printCalls = async (requests: () => Promise<Record<string, any>[]>) =>
  (await requests()).filter((call) => call.args?.includes("--print"));

test("streams UTF-8 once with tools, MCP, hooks, persistence and fallback disabled", async () => {
  const { client, requests, home } = await fixture("success");
  expect(await collect(client.stream(request))).toBe("안녕하세요");
  const calls = await requests();
  const args: string[] = calls.find((call) => call.args?.includes("--print"))!.args;
  expect(args[args.indexOf("--tools") + 1]).toBe("");
  expect(args).toContain("--safe-mode");
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--no-session-persistence");
  expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
  expect(args[args.indexOf("--model") + 1]).toBe("opus");
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  expect(args).not.toContain("--fallback-model");
  expect(args).not.toContain("--bare"); // Bare mode bypasses subscription sign-in.
  const input = calls.find((call) => call.input)!;
  expect(input.system).toContain("untrusted content");
  expect(input.system).toContain("Answer briefly.");
  expect(input.input.message.content).toEqual([{ type: "text", text: "synthetic question" }]);
  expect(calls.filter((call) => call.args).every((call) => call.configDir === home)).toBe(true);
  expect(await readdir(join(home, "workspace"))).toEqual([]);
});

test("an account default model sends no model flag; result-only output still answers", async () => {
  const { client, requests } = await fixture("result-only");
  expect(await collect(client.stream({ ...request, model: "" }))).toBe("안녕하세요");
  expect((await printCalls(requests))[0].args).not.toContain("--model");
});

test("structured completions carry the schema as instructions and return bare JSON", async () => {
  const { client, requests } = await fixture("structured");
  const reply = await client.complete({ ...request, outputSchema: { type: "object", required: ["queries"] } });
  expect(JSON.parse(reply)).toMatchObject({ queries: ["synthetic literature"] });
  expect((await requests()).find((call) => call.input)!.system).toContain('"required":["queries"]');
  expect((await client.status()).quota).toMatchObject({ status: "allowed", utilization: 0.25 });
});

test("a stopped answer is dropped and Claude Code's rewrite is returned with a notice", async () => {
  const { client } = await fixture("refusal-rewrite");
  const notices: string[] = [];
  const reply = await client.complete({ ...request, outputSchema: { type: "object" }, onNotice: (n) => notices.push(n) });
  expect(JSON.parse(reply)).toEqual({ queries: ["synthetic literature"] });
  expect(notices).toEqual(["claude-opus-5-5의 안전장치가 첫 응답을 멈춰 Claude Code가 claude-opus-5로 다시 썼습니다 (분류: bio)."]);
  // Streamed text cannot be taken back, so a stream stops with the reason instead of joining two answers.
  await expect(collect(client.stream(request))).rejects.toThrow("안전장치가 응답을 멈췄습니다 (분류: bio)");
});

test("a stop before any text streams only the rewritten answer", async () => {
  const { client } = await fixture("refusal-thinking");
  expect(await collect(client.stream(request))).toBe('{"queries":["synthetic literature"]}');
});

test("an answer left stopped fails with the reason, not as a format error", async () => {
  const { client, home } = await fixture("refusal-final");
  await expect(client.complete({ ...request, outputSchema: { type: "object" } })).rejects.toThrow("안전장치가 응답을 멈췄습니다 (분류: bio)");
  expect(await readdir(join(home, "workspace"))).toEqual([]);
});

test("jsonReply strips fences and surrounding prose", () => {
  expect(jsonReply('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(jsonReply('결과입니다.\n{"a":{"b":2}}\n끝')).toBe('{"a":{"b":2}}');
  expect(jsonReply(' {"a":1} ')).toBe('{"a":1}');
});

for (const scenario of ["api-key", "third-party", "signed-out", "old"])
  test(`blocks ${scenario} before any generation`, async () => {
    const { client, requests } = await fixture(scenario);
    await expect(collect(client.stream(request))).rejects.toThrow();
    expect(await printCalls(requests)).toHaveLength(0);
  });

for (const scenario of ["quota", "overage", "retry-limit", "limit-result", "assistant-error"])
  test(`stops on ${scenario} without retries or model switches`, async () => {
    const { client, requests } = await fixture(scenario);
    await expect(collect(client.stream(request))).rejects.toThrow("유료 API로 전환하지 않았습니다");
    expect(await printCalls(requests)).toHaveLength(1);
    if (scenario === "quota") {
      // A known future reset blocks the next turn before it starts.
      await expect(collect(client.stream(request))).rejects.toThrow("한도");
      expect(await printCalls(requests)).toHaveLength(1);
    }
  });

for (const scenario of ["malformed", "crash", "truncated", "model-error"])
  test(`surfaces ${scenario} and removes request files`, async () => {
    const { client, home } = await fixture(scenario);
    await expect(collect(client.stream(request))).rejects.toThrow();
    expect(await readdir(join(home, "workspace"))).toEqual([]);
  });

test("cancels a silent process and times out a stalled one", async () => {
  const { client, requests, home } = await fixture("hang", 700);
  const controller = new AbortController();
  const run = collect(client.stream({ ...request, signal: controller.signal }));
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(10);
    if ((await requests()).some((call) => call.input)) break;
  }
  controller.abort();
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect(await readdir(join(home, "workspace"))).toEqual([]);
  await expect(collect(client.stream(request))).rejects.toThrow("시간이 초과");
});

test("official sign-in, cancellation and logout use the isolated config and never Console billing", async () => {
  const { client, requests } = await fixture("login");
  expect((await client.status()).state).toBe("signedOut");
  await client.login();
  expect((await client.status()).state).toBe("signingIn");
  await client.cancelLogin();
  expect((await client.status()).state).toBe("signedOut");
  await client.login();
  await Bun.sleep(300);
  expect(await client.status()).toMatchObject({ state: "connected", plan: "max", email: "test@example.com" });
  expect(await client.models()).toEqual(["opus", "sonnet", "haiku"]);
  await client.logout();
  expect((await client.status()).state).toBe("signedOut");
  const calls = await requests();
  expect(calls.find((call) => call.args?.includes("login"))!.args).toContain("--claudeai");
  expect(calls.some((call) => call.args?.includes("--console"))).toBe(false);
});

test("a missing CLI reports unavailable instead of failing", async () => {
  const home = await mkdtemp(join(tmpdir(), "researchbunny-claude-missing-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const client = new ClaudeClient({ home, command: [join(home, "no-claude")] });
  expect((await client.status()).state).toBe("error");
});

test("the environment excludes API credentials, OAuth tokens, model overrides and endpoints", () => {
  const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CONFIG_DIR"];
  const saved = names.map((name) => process.env[name]);
  try {
    for (const name of names) process.env[name] = "untrusted";
    const env = claudeEnvironment("/private/researchbunny-claude");
    for (const name of names.slice(0, -1)) expect(env[name]).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/private/researchbunny-claude");
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
});

test("sidebar chat streams through Claude and never reaches other providers", async () => {
  let other = 0;
  const provider = new ChatProvider(
    { async *stream() { other++; yield "ollama"; } },
    { async *stream() { other++; yield "codex"; } },
    () => "paid-key",
    async () => { other++; throw new Error("paid call"); },
    { async *stream(input) { expect(input.model).toBe("sonnet"); throw new Error("subscription exhausted"); yield ""; } },
  );
  const config = { ...DEFAULT_AI, aiEnabled: true, aiProvider: "claude" as const, claudeModel: "sonnet" };
  await expect(collect(provider.stream(config, "instruction", "input", new AbortController().signal))).rejects.toThrow("subscription exhausted");
  expect(other).toBe(0);
});

function makeRun(projectId: string): Run {
  return {
    id: crypto.randomUUID(), projectId, mode: "ai", query: "synthetic research question", seedProfileId: null,
    inputIds: [], filters: DEFAULT_FILTERS, status: "running", createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), calls: 0, maxCalls: 40, maxCandidates: 500, total: null, count: 0,
    message: "", tasks: [], rankingVersion: "test", phase: "ai-plan",
  };
}

test("structured AI work uses the Claude subscription without paid API requests, and settings keep the choice", async () => {
  const { client, home } = await fixture("structured");
  const service = new Service(join(home, "library"), "unused", () => {}, new CodexClient(), client);
  const http = spyOn(globalThis, "fetch").mockRejectedValue(new Error("paid API must not be used"));
  try {
    service.secrets.openai = "sentinel-paid-key";
    await service.call("saveSettings", schemas.saveSettings.parse({ ...service.settings(), aiProvider: "claude", claudeModel: "opus", aiEnabled: true }));
    expect(service.settings()).toMatchObject({ aiProvider: "claude", claudeModel: "opus" });
    const run = makeRun(service.db.projects()[0].id);
    service.db.saveRun(run);
    expect(await service.ai.plan(run, new AbortController().signal)).toEqual({ scope: "범위", queries: ["synthetic literature"], subtopics: [] });
    expect(run.ai).toMatchObject({ provider: "claude", model: "opus" });
    expect(http).not.toHaveBeenCalled();
    expect(service.db.usageSummary().some((u) => u.provider === "claude")).toBe(true);
    expect(await service.call("claudeStatus", {})).toMatchObject({ state: "connected" });
  } finally {
    http.mockRestore();
    service.db.close();
  }
});
