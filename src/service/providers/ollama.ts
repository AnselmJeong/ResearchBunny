import { z } from "zod";
import { AppError } from "../../shared/types";
import type { FetchLike } from "../search/web-search";

export interface ModelMessage { role: "system" | "user" | "assistant"; content: string }
const chunkSchema = z.object({
  message: z.object({ content: z.string().optional() }).optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});
const modelSchema = z.object({ models: z.array(z.object({ name: z.string().min(1) })) });

export class OllamaCloud {
  constructor(private key: () => string | undefined, private fetcher: FetchLike = fetch) {}

  private headers() {
    const key = this.key()?.trim();
    if (!key) throw new AppError("API_KEY", "설정에서 Ollama Cloud API 키를 등록하세요.");
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }

  async models(signal = AbortSignal.timeout(15000)): Promise<string[]> {
    const response = await this.fetcher("https://ollama.com/api/tags", { headers: this.headers(), signal });
    if (!response.ok) throw this.error(response.status);
    return modelSchema.parse(await response.json()).models.map(m => m.name).sort();
  }

  private error(status: number) {
    return new AppError("OLLAMA_PROVIDER", `Ollama Cloud 응답 오류 (${status}). 키·모델·사용 한도를 확인하세요.`, status === 429 || status >= 500);
  }

  async *stream(model: string, messages: ModelMessage[], signal: AbortSignal, maxOutput: number, format?: Record<string, unknown>): AsyncGenerator<string> {
    // Ollama Cloud does not support native structured outputs. Supply the schema
    // as instructions; existing recommendation/classification validators remain
    // authoritative and reject malformed results before any library change.
    const input = format ? [
      { role: "system" as const, content: `Return only a JSON object matching this schema, without Markdown fences or commentary: ${JSON.stringify(format)}` },
      ...messages,
    ] : messages;
    const response = await this.fetcher("https://ollama.com/api/chat", {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ model, messages: input, stream: true, options: { num_predict: maxOutput } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]),
    });
    if (!response.ok) throw this.error(response.status);
    if (!response.body) throw new AppError("OLLAMA_STREAM", "Ollama 응답이 비어 있습니다.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", finished = false, size = 0;
    const parse = (line: string) => {
      const chunk = chunkSchema.parse(JSON.parse(line));
      if (chunk.error) throw new AppError("OLLAMA_STREAM", "Ollama가 생성을 완료하지 못했습니다. 모델과 사용 한도를 확인하세요.");
      if (chunk.done) finished = true;
      return chunk.message?.content ?? "";
    };
    try {
      while (!finished) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        size += value?.byteLength ?? 0;
        if (size > 2_000_000) throw new AppError("OLLAMA_STREAM", "Ollama 응답이 너무 큽니다.");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) yield parse(line);
          if (finished) break;
        }
        if (done) {
          if (!finished && buffer.trim()) yield parse(buffer);
          break;
        }
      }
      if (!finished) throw new AppError("OLLAMA_STREAM", "Ollama 연결이 응답 완료 전에 끊겼습니다. 다시 시도하세요.");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async complete(model: string, messages: ModelMessage[], signal: AbortSignal, maxOutput: number, format?: Record<string, unknown>) {
    let output = "";
    for await (const chunk of this.stream(model, messages, signal, maxOutput, format)) output += chunk;
    return output;
  }
}
