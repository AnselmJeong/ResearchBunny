import { z } from "zod";
import { AppError } from "../../shared/types";
import type { FetchLike } from "../search/web-search";

/**
 * Ollama's decision models ("System One": Clef, Nimble, Tev) answer
 * classification questions with probabilities instead of prose. One request
 * carries up to 64 named questions about one input and is billed per input
 * token. https://docs.ollama.com/api/systemone
 */
export const SYSTEMONE_URL = "https://ollama.com/v1/systemone";
export const MAX_QUESTIONS = 64;

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { false?: string; true?: string } }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({ type: z.literal("score"), score: z.number().min(0).max(9), confidence: z.number().optional() }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), z.number()), confidence: z.number().optional() }),
]);
const responseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
});
export type DecisionAnswer = z.infer<typeof answerSchema>;
export interface DecisionReply {
  answers: Record<string, DecisionAnswer>;
  inputTokens: number;
  outputTokens: number;
}

/** Question names: up to 100 ASCII letters, digits, `_`, `.` or `-`. */
export const questionName = (prefix: string, id: string) => `${prefix}.${id}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);

export class DecisionClient {
  constructor(
    private key: () => string | undefined,
    private fetcher: FetchLike = fetch,
    private url = SYSTEMONE_URL,
  ) {}

  configured() {
    return !!this.key()?.trim();
  }

  async ask(model: string, state: string | Record<string, unknown>, questions: Record<string, DecisionQuestion>, signal: AbortSignal): Promise<DecisionReply> {
    const key = this.key()?.trim();
    if (!key) throw new AppError("API_KEY", "결정 모델을 쓰려면 설정에서 Ollama Cloud API 키를 등록하세요.");
    const names = Object.keys(questions);
    if (!names.length) throw new AppError("INVALID", "결정 모델에 물을 질문이 없습니다.");
    if (names.length > MAX_QUESTIONS) throw new AppError("INVALID", `결정 모델 요청 하나에는 질문을 ${MAX_QUESTIONS}개까지 넣을 수 있습니다.`);
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AppError("DECISION_NETWORK", "결정 모델에 연결하지 못했습니다. 네트워크를 확인하세요.", true);
    }
    if (!response.ok) {
      const detail = await response.json().then((body) => (body as { error?: unknown }).error, () => null);
      const reason = typeof detail === "string" ? ` · ${detail.slice(0, 200)}` : "";
      const message =
        response.status === 401 ? "Ollama Cloud API 키가 올바르지 않습니다."
        : response.status === 402 ? "이 결정 모델은 Ollama Cloud 유료 사용 한도가 필요합니다."
        : response.status === 404 ? `결정 모델 ‘${model}’을 찾지 못했습니다. 모델 이름을 확인하세요.`
        : response.status === 413 ? "결정 모델 요청이 너무 큽니다."
        : `결정 모델 응답 오류 (${response.status})`;
      throw new AppError(response.status === 429 ? "BUDGET" : "DECISION_PROVIDER", message + reason, response.status === 429 || response.status >= 500);
    }
    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new AppError("DECISION_FORMAT", "결정 모델 응답 형식이 올바르지 않습니다.", true);
    const missing = names.filter((name) => !(name in parsed.data.answers));
    if (missing.length) throw new AppError("DECISION_FORMAT", `결정 모델이 질문 ${missing.length}개에 답하지 않았습니다.`, true);
    return {
      answers: parsed.data.answers,
      inputTokens: parsed.data.usage?.input_tokens ?? 0,
      outputTokens: parsed.data.usage?.output_tokens ?? 0,
    };
  }
}
