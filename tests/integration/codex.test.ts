import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexClient, parseQuotas } from "../../src/service/codex/client";
import {
  CodexTransport,
  codexEnvironment,
  object,
} from "../../src/service/codex/transport";
import { codexQuotaError, type CodexStatus } from "../../src/shared/codex";
import { AIProvider, DEFAULT_AI } from "../../src/service/providers/openai";
import { Service } from "../../src/service/service";
import { DEFAULT_FILTERS, type Run } from "../../src/shared/types";
import { schemas } from "../../src/shared/contracts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
async function fixture(scenario: string) {
  const home = await mkdtemp(join(tmpdir(), "researchbunny-codex-test-"));
  const log = join(home, "requests.jsonl");
  const transport = () =>
    new CodexTransport({
      home,
      command: [
        process.execPath,
        resolve("tests/fixtures/codex/app-server.ts"),
        scenario,
        log,
      ],
      timeoutMs: 350,
    });
  const client = new CodexClient(transport);
  const requests = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => object(JSON.parse(line)));
  cleanups.push(async () => {
    client.close();
    await Bun.sleep(40);
    await rm(home, { recursive: true, force: true });
  });
  return { home, client, transport, requests };
}
const request = {
  model: "",
  instruction: "Use supplied context only",
  input: "synthetic question",
  outputSchema: { type: "object" },
};
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for fixture");
}
for (const scenario of ["success", "early"])
  test(`stream: ${scenario}, UTF-8, deduplication, tool rejection and schema`, async () => {
    const { client, requests } = await fixture(scenario);
    expect(await client.complete(request)).toBe("안녕하세요");
    const calls = await requests();
    expect(
      calls.find((c) => c.method === "thread/start")?.params,
    ).toMatchObject({
      environments: [],
      dynamicTools: [],
      model: "test-model",
      ephemeral: true,
      approvalPolicy: "never",
    });
    expect(calls.find((c) => c.method === "turn/start")?.params).toMatchObject({
      input: [{ type: "text", text: request.input }],
      outputSchema: request.outputSchema,
      serviceTierForTurn: "default",
    });
    expect(calls.find((c) => c.id === "approval-1")?.error).toMatchObject({
      code: -32601,
    });
  });
for (const scenario of [
  "api-key",
  "login",
  "blocked",
  "exhausted",
  "secondary-exhausted",
  "unknown-quota",
  "other-bucket",
  "negative-quota",
  "quota-error",
  "cursor-loop",
])
  test(`blocks ${scenario} before generation even with credits`, async () => {
    const { client, requests } = await fixture(scenario);
    await expect(client.complete(request)).rejects.toThrow();
    expect(
      (await requests()).some(
        (r) => r.method === "thread/start" || r.method === "turn/start",
      ),
    ).toBe(false);
  });
test("resolves account default before applying model-specific quota; malformed usage stays unknown", () => {
  const status: CodexStatus = {
    state: "connected",
    ordinaryUsageAllowed: true,
    quotas: parseQuotas({
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 5 } },
        special: {
          normalModelSlug: "special-model",
          primary: { usedPercent: 100, resetsAt: 1 },
        },
      },
    }),
  };
  expect(codexQuotaError(status, "special-model")).toContain("한도");
  expect(codexQuotaError(status, "other-model")).toBeNull();
  for (const usedPercent of [-1, NaN, Infinity, "0"]) {
    status.quotas = parseQuotas({ rateLimits: { primary: { usedPercent } } });
    expect(codexQuotaError(status, "test-model")).not.toBeNull();
  }
});
for (const scenario of [
  "crash",
  "malformed",
  "hang-start",
  "limit-turn",
  "interrupted",
])
  test(`settles ${scenario} and can reconnect`, async () => {
    const { client } = await fixture(scenario);
    await expect(client.complete(request)).rejects.toThrow();
    expect((await client.status()).state).toBe("connected");
  });
for (const scenario of ["hang", "hang-interrupt"])
  test(`cancel ${scenario} interrupts actual turn; queued request cancellation is isolated`, async () => {
    const { client, requests } = await fixture(scenario);
    const active = new AbortController(),
      queued = new AbortController();
    const first = client.complete({ ...request, signal: active.signal });
    const firstCheck = first.then(
      () => null,
      (error) => error,
    );
    await until(async () =>
      (await requests()).some((c) => c.method === "turn/start"),
    );
    const second = client.complete({ ...request, signal: queued.signal });
    const secondCheck = second.then(
      () => null,
      (error) => error,
    );
    queued.abort();
    expect(await secondCheck).toBeInstanceOf(Error);
    expect((await requests()).some((c) => c.method === "turn/interrupt")).toBe(
      false,
    );
    expect((await client.status()).state).toBe("connected");
    active.abort();
    expect(await firstCheck).toBeInstanceOf(Error);
    await until(async () =>
      (await requests()).some((c) => c.method === "turn/interrupt"),
    );
  });
test("shutdown while connecting settles initialization and does not resurrect workers", async () => {
  const { client, requests } = await fixture("hang-init");
  const pending = client.complete(request);
  const check = pending.then(
    () => null,
    (error) => error,
  );
  await until(async () =>
    (await requests()).some((c) => c.method === "initialize"),
  );
  client.close();
  expect(await check).toBeInstanceOf(Error);
  expect((await requests()).some((c) => c.method === "thread/start")).toBe(
    false,
  );
});
test("ChatGPT auth lifecycle and model pagination", async () => {
  const { client, requests } = await fixture("login");
  expect((await client.status()).state).toBe("signedOut");
  expect(await client.login()).toStartWith("https://auth.openai.com/");
  expect((await client.status()).state).toBe("signingIn");
  await Bun.sleep(80);
  expect((await client.status()).state).toBe("connected");
  await client.logout();
  expect((await requests()).some((c) => c.method === "account/logout")).toBe(
    true,
  );
  const paged = await fixture("pagination");
  await paged.client.models();
  expect(
    (await paged.requests()).filter((c) => c.method === "model/list"),
  ).toHaveLength(2);
});
test("login cancellation uses owned login ID", async () => {
  const { client, requests } = await fixture("login");
  await client.login();
  await client.cancelLogin();
  expect(
    (await requests()).find((c) => c.method === "account/login/cancel")?.params,
  ).toEqual({ loginId: "login-1" });
});
test("environment does not inherit credentials, provider endpoints or runtime injection", () => {
  const keys = [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
    "NODE_OPTIONS",
    "BUN_OPTIONS",
  ];
  const old = keys.map((k) => process.env[k]);
  try {
    keys.forEach((k) => {
      process.env[k] = "sentinel";
    });
    const env = codexEnvironment("/private/app-home");
    keys.forEach((k) => expect(env[k]).toBeUndefined());
    expect(env.CODEX_HOME).toBe("/private/app-home");
  } finally {
    keys.forEach((k, i) => {
      if (old[i] === undefined) delete process.env[k];
      else process.env[k] = old[i];
    });
  }
});
function makeRun(projectId: string): Run {
  return {
    id: crypto.randomUUID(),
    projectId,
    mode: "ai",
    query: "synthetic question",
    seedProfileId: null,
    inputIds: [],
    filters: DEFAULT_FILTERS,
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    calls: 0,
    maxCalls: 40,
    maxCandidates: 500,
    total: null,
    count: 0,
    message: "",
    tasks: [],
    rankingVersion: "test",
    phase: "ai-plan",
  };
}
test("normal plan adapter supplies context and validates structured answer without API requests", async () => {
  const { client, home, requests } = await fixture("structured");
  const service = new Service(
    join(home, "library"),
    "unused",
    () => {},
    client,
  );
  const http = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("paid API must not be used"),
  );
  try {
    service.secrets.openai = "sentinel-paid-key";
    service.db.pref("ai", { ...DEFAULT_AI, aiEnabled: true });
    const run = makeRun(service.db.projects()[0].id);
    service.db.saveRun(run);
    expect(await service.ai.plan(run, new AbortController().signal)).toEqual({
      scope: "범위",
      queries: ["synthetic literature"],
      subtopics: [],
    });
    expect(http).not.toHaveBeenCalled();
    const turn = object(
      (await requests()).find((r) => r.method === "turn/start")?.params,
    );
    expect(turn.input).toEqual([
      {
        type: "text",
        text: JSON.stringify({ question: run.query }),
        text_elements: [],
      },
    ]);
    expect(service.db.usageSummary().some((u) => u.provider === "codex")).toBe(
      true,
    );
  } finally {
    http.mockRestore();
    service.db.close();
  }
});
test("all AI completion/error routes remain in Codex with saved paid credentials", async () => {
  const { client, home } = await fixture("blocked");
  const service = new Service(
    join(home, "library"),
    "unused",
    () => {},
    client,
  );
  const http = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("paid API must not be used"),
  );
  try {
    const ai = new AIProvider(
      service.db,
      () => "sentinel-paid-key",
      () => ({ ...DEFAULT_AI, aiEnabled: true }),
      http,
      client,
    );
    const run = makeRun(service.db.projects()[0].id);
    service.db.saveRun(run);
    await expect(ai.plan(run, new AbortController().signal)).rejects.toThrow(
      "유료 API",
    );
    await expect(
      ai.structured(
        run,
        "recommendations",
        {},
        "candidate context",
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("유료 API");
    await service.call("codexModels", {});
    expect(http).not.toHaveBeenCalled();
    expect(service.db.run(run.id).query).toBe(run.query);
  } finally {
    http.mockRestore();
    service.db.close();
  }
});
test("old settings preserve API model/key and new Codex default survives persistence", async () => {
  const { home, client } = await fixture("success");
  const service = new Service(
    join(home, "library"),
    "unused",
    () => {},
    client,
  );
  try {
    service.db.pref("ai", { model: "old-api-model", aiEnabled: true });
    service.secrets.openai = "sentinel";
    const settings = service.settings();
    expect(settings).toMatchObject({
      aiProvider: "codex",
      codexModel: "",
      model: "old-api-model",
      openaiConfigured: true,
    });
    await service.call(
      "saveSettings",
      schemas.saveSettings.parse({ ...settings, codexModel: "test-model" }),
    );
    expect(service.settings().codexModel).toBe("test-model");
    await service.call(
      "saveSettings",
      schemas.saveSettings.parse({ ...settings, aiProvider: "openai" }),
    );
    expect(service.settings()).toMatchObject({
      aiProvider: "openai",
      codexModel: "",
      model: "old-api-model",
    });
  } finally {
    service.db.close();
  }
});
