import { AppError } from "../../shared/types";
import { CLAUDE_REFUSAL } from "../../shared/claude";
import type { GenealogyProvider, ModelRoute } from "../../shared/genealogy";
import type { CodexClient } from "../codex/client";
import type { ClaudeClient } from "../claude/client";
import { jsonReply } from "../claude/client";
import type { OllamaCloud } from "../providers/ollama";
import type { Library } from "../db/database";

/**
 * Limits for one genealogy job. A report makes hundreds of calls, so it keeps
 * its own budget instead of the 3-call limit of recommendations.
 */
export class Meter {
  calls = 0;
  inputBytes = 0;
  constructor(public limits: { maxCalls: number; maxInputBytesPerCall: number }) {}
  reserve(bytes: number) {
    if (bytes > this.limits.maxInputBytesPerCall)
      throw new AppError("AI_INPUT", `한 번에 AI에 보낼 입력이 상한(${Math.round(this.limits.maxInputBytesPerCall / 1000)} KB)을 넘었습니다.`);
    if (this.calls >= this.limits.maxCalls)
      throw new AppError("BUDGET", `이 작업의 AI 호출 상한 ${this.limits.maxCalls}회에 도달했습니다. 상한을 늘린 뒤 재개하세요.`);
    this.calls++;
    this.inputBytes += bytes;
  }
}

export interface JsonRequest<T> {
  route: ModelRoute;
  /** The run the call is counted against in provider usage. */
  runId: string;
  instruction: string;
  input: string;
  schema: Record<string, unknown>;
  /** Throws when the reply is unusable; one corrective retry follows. `attempt` is 0 for the first reply, also when that reply was not JSON at all. */
  parse: (value: unknown, attempt: number) => T;
  signal: AbortSignal;
  meter?: Meter;
  maxOutputTokens?: number;
  /** Collects what the provider reported about the reply, such as a rewrite after a safeguard stop. */
  notices?: string[];
}

export interface GenealogyClients {
  codex?: Pick<CodexClient, "complete">;
  claude?: Pick<ClaudeClient, "complete">;
  ollama?: Pick<OllamaCloud, "complete">;
}

const LIMIT = /한도|usage.?limit|rate.?limit|quota/i;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Structured completions for genealogy work: a stage's route, a corrective retry, and quota errors that pause instead of fail. */
export class GenealogyAI {
  /** `models`: the model Settings names for each connection, read at every call; a route without a model follows it. */
  constructor(
    private db: Library,
    private clients: GenealogyClients,
    private models: () => Partial<Record<GenealogyProvider, string>> = () => ({}),
    /** Waits before asking again after a dropped connection or a provider hiccup. A report runs for hours; one of these must not end it. */
    private retryDelays: number[] = [2000, 10000],
  ) {}

  private async raw(request: JsonRequest<unknown>, instruction: string, input: string): Promise<string> {
    const { schema, signal } = request;
    const route = { ...request.route, model: request.route.model || this.models()[request.route.provider] || "" };
    request.meter?.reserve(Buffer.byteLength(instruction + input + JSON.stringify(schema)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(request, route, instruction, input);
      } catch (error) {
        const delay = this.retryDelays[attempt];
        if (signal.aborted || delay === undefined || !(error instanceof AppError) || error.code !== "AI_PROVIDER") throw error;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
      }
    }
  }

  /** One request. Errors come out as BUDGET (pause), AI_REFUSAL, AI_PROVIDER (worth another try) or the provider's own setup error. */
  private async once(request: JsonRequest<unknown>, route: ModelRoute, instruction: string, input: string): Promise<string> {
    const { schema, signal } = request;
    try {
      let reply: string;
      if (route.provider === "codex") {
        if (!this.clients.codex) throw new AppError("CODEX_UNAVAILABLE", "Codex 연결을 사용할 수 없습니다.");
        reply = await this.clients.codex.complete({ model: route.model, instruction, input, outputSchema: schema, signal });
      } else if (route.provider === "claude") {
        if (!this.clients.claude) throw new AppError("CLAUDE_UNAVAILABLE", "Claude 연결을 사용할 수 없습니다.");
        reply = await this.clients.claude.complete({ model: route.model, instruction, input, outputSchema: schema, signal, onNotice: (n) => request.notices?.push(n) });
      } else {
        if (!this.clients.ollama) throw new AppError("OLLAMA_UNAVAILABLE", "Ollama 연결을 사용할 수 없습니다.");
        if (!route.model) throw new AppError("OLLAMA_MODEL", "설정 → AI 연결에서 Ollama Cloud 모델을 정하거나, 리포트 설정에서 모델을 고르세요.");
        reply = await this.clients.ollama.complete(
          route.model,
          [{ role: "system", content: instruction }, { role: "user", content: input }],
          signal,
          request.maxOutputTokens ?? 16000,
          schema,
        );
      }
      this.db.usage(route.provider, request.runId);
      return reply;
    } catch (error) {
      if (signal.aborted) throw error;
      const message = errorText(error);
      if (error instanceof AppError) {
        // Ollama Cloud reports its HTTP status in one error: a rate limit pauses like the subscriptions do,
        // and a server error or a cut stream is worth asking again.
        if (error.code === "OLLAMA_PROVIDER" && /\(429\)/.test(message)) throw new AppError("BUDGET", message, true);
        if ((error.code === "OLLAMA_PROVIDER" && /\(5\d\d\)/.test(message)) || error.code === "OLLAMA_STREAM") throw new AppError("AI_PROVIDER", message, true);
        throw error;
      }
      // A spent subscription pauses the job; it resumes once the limit resets.
      if (LIMIT.test(message)) throw new AppError("BUDGET", message, true);
      // A stopped answer is not a format problem; asking the same model again is usually stopped again.
      if (CLAUDE_REFUSAL.test(message)) throw new AppError("AI_REFUSAL", message, true);
      throw new AppError("AI_PROVIDER", message || "AI 요청이 실패했습니다.", true);
    }
  }

  async json<T>(request: JsonRequest<T>): Promise<T> {
    let reply = await this.raw(request as JsonRequest<unknown>, request.instruction, request.input);
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return request.parse(JSON.parse(jsonReply(reply)), attempt);
      } catch (error) {
        problem = error instanceof SyntaxError ? `the reply was not valid JSON (${error.message})` : errorText(error).slice(0, 800);
      }
      if (attempt === 1) break;
      request.signal.throwIfAborted();
      reply = await this.raw(
        request as JsonRequest<unknown>,
        `${request.instruction}\n\nYour previous reply was rejected: ${problem}. Return the complete answer again as one JSON object, with nothing before or after it, that matches the schema and every rule above.`,
        request.input,
      );
    }
    throw new AppError("AI_FORMAT", `AI 응답을 두 번 받았지만 형식이 맞지 않았습니다: ${problem}`, true);
  }
}
