import { useEffect, useRef, useState } from "react";
import { CLAUDE_MODELS, type ClaudeStatus } from "../../shared/claude";

const MODEL_NAMES: Record<string, string> = {
  opus: "Opus · 가장 정교함",
  sonnet: "Sonnet · 균형",
  haiku: "Haiku · 빠름",
};

export function ClaudeConnection({
  model,
  onModel,
}: {
  model: string;
  onModel: (model: string) => void;
}) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = async () => {
    const id = ++generation.current;
    const next = await window.bunny.claudeStatus({});
    if (id === generation.current) setStatus(next);
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "연결을 확인하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh().catch((e) =>
      setError(e instanceof Error ? e.message : "연결 실패"),
    );
    return () => {
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (status?.state !== "signingIn") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : "연결 실패");
      }
      if (!disposed) timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 2500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [status?.state]);
  const labels = {
    unavailable: "Claude Code CLI를 사용할 수 없습니다",
    signedOut: "로그인 필요",
    signingIn: "브라우저에서 로그인 중",
    connected: "연결됨",
    error: "연결 확인 필요",
  };
  const quota = status?.quota;
  return (
    <div className="claude-connection">
      <p role="status">
        {status ? labels[status.state] : "Claude 연결 확인 중…"}
        {status?.plan ? ` · ${status.plan}` : ""}
        {status?.email ? ` · ${status.email}` : ""}
      </p>
      <div className="inline-actions">
        {status?.state !== "connected" && status?.state !== "signingIn" && status?.state !== "unavailable" && (
          <button
            disabled={busy}
            onClick={() => void action(() => window.bunny.claudeLogin({}))}
          >
            Claude 계정으로 로그인
          </button>
        )}
        {status?.state === "signingIn" && (
          <button
            disabled={busy}
            onClick={() => void action(() => window.bunny.claudeCancelLogin({}))}
          >
            로그인 취소
          </button>
        )}
        {(status?.state === "connected" || status?.state === "error") && (
          <button
            disabled={busy}
            onClick={() => void action(() => window.bunny.claudeLogout({}))}
          >
            로그아웃
          </button>
        )}
        <button disabled={busy} onClick={() => void action(async () => {})}>
          연결 새로고침
        </button>
      </div>
      <label className="field">
        구독 모델
        <select value={model} onChange={(e) => onModel(e.target.value)}>
          <option value="">계정 기본 모델</option>
          {model && !CLAUDE_MODELS.includes(model) && (
            <option value={model}>{model} · 사용 가능 여부 확인 필요</option>
          )}
          {CLAUDE_MODELS.map((m) => (
            <option key={m} value={m}>
              {MODEL_NAMES[m] ?? m}
            </option>
          ))}
        </select>
      </label>
      {quota && (
        <p className="subtle">
          마지막 응답 기준 한도 상태: {quota.status}
          {typeof quota.utilization === "number"
            ? ` · 사용 ${Math.round(quota.utilization * 100)}%`
            : ""}
          {quota.resetsAt
            ? ` · 갱신 ${new Date(quota.resetsAt * 1000).toLocaleString()}`
            : ""}
        </p>
      )}
      {status?.cliVersion && (
        <p className="subtle">Claude Code {status.cliVersion}</p>
      )}
      {(error || status?.error) && (
        <p className="notice" role="alert">
          {error || status?.error}
        </p>
      )}
      <p className="subtle">
        설치된 Claude Code CLI로 Claude 구독에 연결합니다. 로그인은 ResearchBunny
        전용으로 보관하고, 도구·MCP·확장 없이 답변만 받습니다. 한도에 도달하거나
        초과 사용이 시작되면 중단하며, 유료 API로 자동 전환하지 않습니다. 한도
        상태는 마지막 응답에서 관찰한 값이고 실시간 잔량이 아닙니다.
      </p>
    </div>
  );
}
