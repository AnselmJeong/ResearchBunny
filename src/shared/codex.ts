export interface CodexQuotaWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexQuota {
  id: string;
  name: string;
  model: string | null;
  invalid: boolean;
  blocked: boolean;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
}

export interface CodexStatus {
  state: "unavailable" | "signedOut" | "signingIn" | "connected" | "error";
  email?: string;
  plan?: string;
  error?: string;
  ordinaryUsageAllowed: boolean | null;
  quotas: CodexQuota[];
}

export interface CodexModel {
  id: string;
  isDefault: boolean;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
}

export function codexQuotaError(
  status: CodexStatus,
  model: string,
): string | null {
  if (status.state !== "connected")
    return status.error || "설정에서 Codex에 ChatGPT 계정으로 로그인해 주세요.";
  const relevant = status.quotas.filter(
    (q) =>
      q.model === model ||
      q.id === model ||
      (!q.model && (q.id === "codex" || q.id === "default")),
  );
  const windows = relevant
    .flatMap((q) => [q.primary, q.secondary])
    .filter((w) => w !== null);
  if (
    status.ordinaryUsageAllowed === false ||
    relevant.some((q) => q.blocked) ||
    windows.some((w) => w.usedPercent >= 100)
  ) {
    return "Codex 구독 사용 한도에 도달했습니다. 한도가 초기화된 뒤 다시 시도해 주세요. 유료 API로 전환하지 않았습니다.";
  }
  if (
    status.error ||
    status.ordinaryUsageAllowed !== true ||
    relevant.some((q) => q.invalid)
  ) {
    return "Codex 구독 한도를 확인할 수 없어 요청을 중단했습니다. 설정에서 연결 상태를 새로고침해 주세요. 유료 API로 전환하지 않았습니다.";
  }
  return null;
}
