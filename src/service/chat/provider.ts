import { z } from "zod";
import { AppError } from "../../shared/types";
import type { AIConfig } from "../providers/openai";
import type { OllamaCloud, ModelMessage } from "../providers/ollama";
import type { CodexClient } from "../codex/client";
import type { FetchLike } from "../search/web-search";

export class ChatProvider {
  constructor(
    private ollama: Pick<OllamaCloud, "stream">,
    private codex: Pick<CodexClient, "stream">,
    private openaiKey: () => string | undefined,
    private fetcher: FetchLike = fetch,
  ) {}

  async *stream(config: AIConfig, instruction: string, input: string, signal: AbortSignal): AsyncGenerator<string> {
    if (!config.aiEnabled) throw new AppError("AI_DISABLED", "설정에서 AI 사용을 켜 주세요.");
    const inputSize = Buffer.byteLength(instruction + input) + 512;
    if (inputSize > config.aiMaxInputTokens) throw new AppError("BUDGET", "AI 입력량 상한을 넘었습니다. 새 대화를 시작하거나 설정에서 입력량 상한을 높여 주세요.");
    if (config.aiProvider === "codex") {
      yield* this.codex.stream({ model: config.codexModel, instruction, input, signal });
      return;
    }
    const messages: ModelMessage[] = [{ role: "system", content: instruction }, { role: "user", content: input }];
    if (config.aiProvider === "ollama") {
      yield* this.ollama.stream(config.ollamaModel, messages, signal, config.aiMaxOutputTokens);
      return;
    }
    if (config.aiProvider !== "openai") throw new AppError("AI_PROVIDER", "AI 연결 설정을 확인하세요.");
    const key = this.openaiKey();
    if (!key) throw new AppError("API_KEY", "OpenAI API 키를 등록하세요.");
    const maxCost = (inputSize * config.inputPricePerMillion + config.aiMaxOutputTokens * config.outputPricePerMillion) / 1e6;
    if (maxCost > config.aiBudgetUsd) throw new AppError("BUDGET", "설정한 OpenAI API 요청 금액 상한을 넘었습니다.");
    // Explicit legacy API selection only. Neither subscription nor Ollama failures enter this branch.
    const response = await this.fetcher("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, store: false, instructions: instruction, input, max_output_tokens: config.aiMaxOutputTokens }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    });
    if (!response.ok) throw new AppError("AI_PROVIDER", `OpenAI 응답 오류 (${response.status}). 키·모델·한도를 확인하세요.`);
    const payload = z.object({ status: z.string(), output: z.array(z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })) }).parse(await response.json());
    if (payload.status !== "completed") throw new AppError("AI_INCOMPLETE", "OpenAI가 답변을 완료하지 못했습니다.");
    const result = payload.output.flatMap(o => o.content ?? []).filter(c => c.type === "output_text").map(c => c.text ?? "").join("");
    if (!result.trim()) throw new AppError("AI_EMPTY", "AI 답변이 비어 있습니다.");
    yield result;
  }
}
