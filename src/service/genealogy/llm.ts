import { AppError } from "../../shared/types";
import type { ModelRoute } from "../../shared/genealogy";
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
  /** Throws when the reply is unusable; one corrective retry follows. */
  parse: (value: unknown) => T;
  signal: AbortSignal;
  meter?: Meter;
  maxOutputTokens?: number;
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
  constructor(private db: Library, private clients: GenealogyClients) {}

  private async raw(request: JsonRequest<unknown>, instruction: string, input: string): Promise<string> {
    const { route, schema, signal } = request;
    request.meter?.reserve(Buffer.byteLength(instruction + input + JSON.stringify(schema)));
    try {
      let reply: string;
      if (route.provider === "codex") {
        if (!this.clients.codex) throw new AppError("CODEX_UNAVAILABLE", "Codex 연결을 사용할 수 없습니다.");
        reply = await this.clients.codex.complete({ model: route.model, instruction, input, outputSchema: schema, signal });
      } else if (route.provider === "claude") {
        if (!this.clients.claude) throw new AppError("CLAUDE_UNAVAILABLE", "Claude 연결을 사용할 수 없습니다.");
        reply = await this.clients.claude.complete({ model: route.model, instruction, input, outputSchema: schema, signal });
      } else {
        if (!this.clients.ollama) throw new AppError("OLLAMA_UNAVAILABLE", "Ollama 연결을 사용할 수 없습니다.");
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
      if (signal.aborted || error instanceof AppError) throw error;
      const message = errorText(error);
      // A spent subscription pauses the job; it resumes once the limit resets.
      if (LIMIT.test(message)) throw new AppError("BUDGET", message, true);
      throw new AppError("AI_PROVIDER", message || "AI 요청이 실패했습니다.", true);
    }
  }

  async json<T>(request: JsonRequest<T>): Promise<T> {
    let reply = await this.raw(request as JsonRequest<unknown>, request.instruction, request.input);
    let problem = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return request.parse(JSON.parse(jsonReply(reply)));
      } catch (error) {
        problem = error instanceof SyntaxError ? "the reply was not valid JSON" : errorText(error).slice(0, 800);
      }
      if (attempt === 1) break;
      request.signal.throwIfAborted();
      reply = await this.raw(
        request as JsonRequest<unknown>,
        `${request.instruction}\n\nYour previous reply was rejected: ${problem}. Return the complete answer again as one JSON object that matches the schema and every rule above.`,
        request.input,
      );
    }
    throw new AppError("AI_FORMAT", `AI 응답을 두 번 받았지만 형식이 맞지 않았습니다: ${problem}`, true);
  }
}
