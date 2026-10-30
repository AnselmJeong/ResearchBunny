// A stand-in for the official Claude Code CLI. It logs every invocation and
// replays the stream-json events of one scenario.
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenario, log, ...args] = process.argv.slice(2);
const marker = join(process.env.CLAUDE_CONFIG_DIR!, "signed-in");
appendFileSync(log, `${JSON.stringify({ args, apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN, endpoint: process.env.ANTHROPIC_BASE_URL, configDir: process.env.CLAUDE_CONFIG_DIR })}\n`);
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
if (args.includes("--version")) {
  console.log(scenario === "old" ? "2.1.200 (Claude Code)" : "2.1.296 (Claude Code)");
} else if (args.includes("status")) {
  const loggedIn = (scenario !== "login" && scenario !== "signed-out") || existsSync(marker);
  send({ loggedIn, authMethod: scenario === "api-key" ? "api_key" : "claude.ai", apiProvider: scenario === "third-party" ? "bedrock" : "firstParty", subscriptionType: "max", email: "test@example.com", orgId: "org" });
  if (!loggedIn) process.exitCode = 1;
} else if (args.includes("login")) {
  await Bun.sleep(150);
  writeFileSync(marker, "ok");
} else if (args.includes("logout")) {
  if (existsSync(marker)) unlinkSync(marker);
} else if (args.includes("--print")) {
  const input = await Bun.stdin.text();
  const system = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
  appendFileSync(log, `${JSON.stringify({ input: JSON.parse(input), system })}\n`);
  if (scenario === "hang") await Bun.sleep(60_000);
  else if (scenario === "malformed") console.log("not-json");
  else if (scenario === "crash") process.exitCode = 1;
  else if (scenario === "quota" || scenario === "overage") {
    send({ type: "rate_limit_event", rate_limit_info: { status: scenario === "quota" ? "rejected" : "allowed", isUsingOverage: scenario === "overage", resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    await Bun.sleep(60_000);
  } else if (scenario === "retry-limit") {
    send({ type: "system", subtype: "api_retry", error_status: 429 });
    await Bun.sleep(60_000);
  } else if (scenario === "limit-result" || scenario === "model-error") {
    send({ type: "result", subtype: "error_during_execution", is_error: true, errors: [scenario === "limit-result" ? "Rate limit exceeded" : "Model unavailable"] });
    process.exitCode = 1;
  } else if (scenario === "assistant-error") {
    send({ type: "assistant", error: "rate_limit" });
    process.exitCode = 1;
  } else if (scenario.startsWith("refusal-")) {
    // Opus safeguards stop the first message; Claude Code continues once with another model in the same turn.
    const event = (value: unknown) => send({ type: "stream_event", event: value });
    const answer = '{"queries":["synthetic literature"]}';
    event({ type: "message_start", message: { model: "claude-opus-5-5" } });
    if (scenario === "refusal-thinking") event({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private" } });
    else event({ type: "content_block_delta", delta: { type: "text_delta", text: '{"queries":["partial' } });
    event({ type: "message_delta", delta: { stop_reason: "refusal", stop_details: { type: "refusal", category: "bio" } } });
    if (scenario === "refusal-final") send({ type: "result", subtype: "success", is_error: false, result: '{"queries":["partial' });
    else {
      send({ type: "system", subtype: "model_refusal_fallback", trigger: "refusal", original_model: "claude-opus-5-5", fallback_model: "claude-opus-5", api_refusal_category: "bio" });
      event({ type: "message_start", message: { model: "claude-opus-5" } });
      event({ type: "content_block_delta", delta: { type: "text_delta", text: answer } });
      event({ type: "message_delta", delta: { stop_reason: "end_turn" } });
      send({ type: "result", subtype: "success", is_error: false, result: answer });
    }
  } else if (scenario === "structured") {
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.25 } });
    const reply = '```json\n{"scope":"범위","queries":["synthetic literature"],"subtopics":[]}\n```';
    send({ type: "stream_event", event: { delta: { type: "text_delta", text: reply } } });
    send({ type: "result", subtype: "success", is_error: false, result: reply });
  } else {
    if (scenario !== "result-only") {
      send({ type: "stream_event", event: { delta: { type: "thinking_delta", thinking: "private" } } });
      const bytes = Buffer.from(JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: "안녕하세요" } } }) + "\n");
      const split = bytes.indexOf(Buffer.from("안")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      await Bun.sleep(5);
      process.stdout.write(bytes.subarray(split));
      send({ type: "assistant", message: { content: [{ type: "text", text: "안녕하세요" }] } });
    }
    if (scenario !== "truncated") send({ type: "result", subtype: "success", is_error: false, result: "안녕하세요" });
  }
}
