import type { Settings } from "./types";

/** Genealogy reports run long jobs on subscriptions or Ollama only; the paid OpenAI API is never used for them. */
export type GenealogyProvider = "codex" | "claude" | "ollama";
export interface ModelRoute {
  provider: GenealogyProvider;
  /** Empty uses the account's default model. */
  model: string;
}
/** light: types, section boundaries, candidate judgements. cards: one call per paper. write: ledger, outline, sections, review. */
export type GenealogyStage = "light" | "cards" | "write";
export type ModelRoutes = Record<GenealogyStage, ModelRoute>;

/** Every stage starts on the connection chosen in Settings, falling back to Codex when that is the paid API. */
export function defaultRoutes(settings: Pick<Settings, "aiProvider" | "codexModel" | "claudeModel" | "ollamaModel">): ModelRoutes {
  const route: ModelRoute =
    settings.aiProvider === "claude"
      ? { provider: "claude", model: settings.claudeModel }
      : settings.aiProvider === "ollama"
        ? { provider: "ollama", model: settings.ollamaModel }
        : { provider: "codex", model: settings.aiProvider === "codex" ? settings.codexModel : "" };
  return { light: { ...route }, cards: { ...route }, write: { ...route } };
}

export const PROVIDER_NAMES: Record<GenealogyProvider, string> = {
  codex: "Codex 구독",
  claude: "Claude 구독",
  ollama: "Ollama Cloud",
};
