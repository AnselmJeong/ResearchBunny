import { z } from "zod";
import { AppError } from "../../shared/types";
import { DEFAULT_OLLAMA_URL, isLoopbackUrl, type OllamaStatus } from "../../shared/shelf";
import type { FetchLike } from "../search/web-search";

const tagsSchema = z.object({ models: z.array(z.object({ name: z.string(), digest: z.string().default("") }).passthrough()) });
const embedSchema = z.object({ embeddings: z.array(z.array(z.number())) });

/** L2-normalize so cosine similarity becomes a dot product. */
export function normalize(values: ArrayLike<number>): Float32Array {
  const vector = Float32Array.from(values);
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

/** Local Ollama (`/api/embed`). Abstracts and queries stay on this Mac by default. */
export class OllamaLocal {
  constructor(private base: () => string = () => DEFAULT_OLLAMA_URL, private fetcher: FetchLike = fetch) {}

  private url(path: string) {
    return new URL(path, this.base().replace(/\/+$/, "") + "/").href;
  }

  async status(model: string, signal = AbortSignal.timeout(3000)): Promise<OllamaStatus> {
    const url = this.base();
    const empty = { running: false, url, loopback: isLoopbackUrl(url), models: [], modelInstalled: false };
    try {
      const [tags, version] = await Promise.all([
        this.fetcher(this.url("api/tags"), { signal }),
        this.fetcher(this.url("api/version"), { signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (!tags.ok) return { ...empty, error: `Ollama 응답 오류 (${tags.status})` };
      const models = tagsSchema.parse(await tags.json()).models.map((m) => ({ name: m.name, digest: m.digest }));
      const found = models.find((m) => m.name === model);
      return {
        running: true,
        url,
        loopback: isLoopbackUrl(url),
        version: typeof version?.version === "string" ? version.version : undefined,
        models,
        modelInstalled: !!found,
        ...(found ? { modelKey: modelKey(found.name, found.digest) } : {}),
      };
    } catch {
      return { ...empty, error: "Ollama가 실행 중이 아닙니다." };
    }
  }

  async embed(model: string, inputs: string[], signal: AbortSignal): Promise<Float32Array[]> {
    if (!inputs.length) return [];
    let response: Response;
    try {
      response = await this.fetcher(this.url("api/embed"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: inputs, truncate: true, keep_alive: "10m" }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new AppError("OLLAMA_OFFLINE", "로컬 Ollama에 연결하지 못했습니다. Ollama를 실행하세요.", true);
    }
    if (response.status === 404) throw new AppError("OLLAMA_MODEL", `Ollama에 ${model} 모델이 없습니다. 설정의 안내에 따라 모델을 받으세요.`);
    if (!response.ok) throw new AppError("OLLAMA_EMBED", `Ollama 임베딩 실패 (${response.status})`, response.status >= 500);
    const parsed = embedSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.embeddings.length !== inputs.length)
      throw new AppError("OLLAMA_EMBED", "Ollama 임베딩 응답을 해석하지 못했습니다.");
    return parsed.data.embeddings.map(normalize);
  }

  /** Download a model; only started by an explicit user action. */
  async pull(model: string, signal: AbortSignal) {
    const response = await this.fetcher(this.url("api/pull"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
      signal,
    });
    if (!response.ok) throw new AppError("OLLAMA_PULL", `모델을 받지 못했습니다 (${response.status}).`, true);
  }
}

export const modelKey = (name: string, digest: string) => `${name}@${digest.replace(/^sha256:/, "").slice(0, 12) || "unknown"}`;
