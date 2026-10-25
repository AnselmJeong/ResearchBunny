export interface ClaudeQuota {
  status: string;
  resetsAt?: number;
  utilization?: number;
  /** When the CLI last reported it: the quota is observed after a response, not a live balance. */
  checkedAt: number;
}

export interface ClaudeStatus {
  state: "unavailable" | "signedOut" | "signingIn" | "connected" | "error";
  cliPath?: string;
  cliVersion?: string;
  email?: string;
  plan?: string;
  error?: string;
  quota?: ClaudeQuota;
}

/** Official CLI aliases, not a claim that every account can use every model. */
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku"];
export const CLAUDE_MIN_VERSION = "2.1.273";
export const CLAUDE_LIMIT_ERROR =
  "Claude 구독 사용 한도에 도달했습니다. 한도가 초기화된 뒤 다시 시도해 주세요. 유료 API로 전환하지 않았습니다.";
