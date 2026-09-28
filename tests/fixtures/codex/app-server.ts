// A deterministic stdio peer: exercises the production transport without network or credentials.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.argv[2];
const logFile = process.argv[3];
let signedIn = scenario !== "login";
function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function notification(method: string, params: unknown) {
  send({ method, params });
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(logFile, `${line}\n`);
  if (!request.method || request.id === undefined) continue;
  const reply = (result: unknown) => send({ id: request.id, result });
  switch (request.method) {
    case "initialize":
      if (scenario !== "hang-init") reply({ userAgent: "fixture" });
      break;
    case "account/read":
      reply({
        account: !signedIn
          ? null
          : scenario === "api-key"
            ? { type: "apiKey" }
            : { type: "chatgpt", email: "test@example.com", planType: "plus" },
      });
      break;
    case "account/rateLimits/read":
      if (scenario === "quota-error")
        send({ id: request.id, error: { code: -1, message: "offline" } });
      else
        reply({
          ordinaryUsageAllowed:
            scenario === "blocked"
              ? false
              : scenario === "unknown-quota" || scenario === "other-bucket"
                ? null
                : true,
          rateLimits:
            scenario === "unknown-quota"
              ? {}
              : {
                  limitId: scenario === "other-bucket" ? "review" : "codex",
                  secondary:
                    scenario === "secondary-exhausted"
                      ? { usedPercent: 100 }
                      : null,
                  primary: {
                    usedPercent:
                      scenario === "exhausted"
                        ? 100
                        : scenario === "negative-quota"
                          ? -1
                          : 20,
                    windowDurationMins: 300,
                    resetsAt: 2_000_000_000,
                  },
                  credits: { hasCredits: true, unlimited: true },
                },
        });
      break;
    case "account/login/start":
      reply({
        type: "chatgpt",
        loginId: "login-1",
        authUrl: "https://auth.openai.com/authorize?test=1",
      });
      setTimeout(() => {
        signedIn = true;
        notification("account/login/completed", {
          loginId: "login-1",
          success: true,
        });
      }, 60);
      break;
    case "account/login/cancel":
      signedIn = false;
      reply({ status: "canceled" });
      break;
    case "account/logout":
      signedIn = false;
      reply({});
      break;
    case "model/list":
      reply({
        data: [
          {
            id: "model-alias",
            model: "test-model",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
            defaultReasoningEffort: "low",
          },
        ],
        nextCursor:
          scenario === "cursor-loop"
            ? "same"
            : scenario === "pagination" && !request.params.cursor
              ? "page2"
              : null,
      });
      break;
    case "thread/start":
      reply({ thread: { id: "thread-1" } });
      break;
    case "turn/start": {
      if (scenario === "crash") process.exit(7);
      if (scenario === "malformed") {
        process.stdout.write("not json\n");
        break;
      }
      if (scenario === "hang-start") break;
      if (scenario !== "early") reply({ turn: { id: "turn-1" } });
      if (scenario === "hang" || scenario === "hang-interrupt") break;
      const params = {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
      };
      if (scenario === "limit-turn") {
        notification("turn/completed", {
          ...params,
          turn: {
            status: "failed",
            error: {
              message: "Usage limit exceeded",
              codexErrorInfo: "usageLimitExceeded",
            },
          },
        });
        break;
      }
      // Unrelated threads must not contaminate the Sidebar response.
      notification("item/agentMessage/delta", {
        ...params,
        threadId: "other",
        delta: "WRONG",
      });
      notification("item/reasoning/summaryTextDelta", {
        ...params,
        delta: "thinking",
      });
      send({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params,
      });
      const answer =
        scenario === "structured"
          ? JSON.stringify({
              scope: "범위",
              queries: ["synthetic literature"],
              subtopics: [],
            })
          : "안녕하세요";
      const bytes = Buffer.from(
        `${JSON.stringify({ method: "item/agentMessage/delta", params: { ...params, delta: answer } })}\n`,
      );
      const split = Math.max(1, bytes.indexOf(Buffer.from("안")) + 1);
      process.stdout.write(bytes.subarray(0, split));
      setTimeout(() => {
        process.stdout.write(bytes.subarray(split));
        notification("item/completed", {
          ...params,
          item: { id: "message-1", type: "agentMessage", text: answer },
        });
        notification("turn/completed", {
          ...params,
          turn: {
            status: scenario === "interrupted" ? "interrupted" : "completed",
            error: null,
          },
        });
        if (scenario === "early") reply({ turn: { id: "turn-1" } });
      }, 10);
      break;
    }
    case "turn/interrupt":
      if (scenario !== "hang-interrupt") reply({});
      break;
    case "thread/unsubscribe":
      reply({});
      break;
    default:
      reply({});
  }
}
