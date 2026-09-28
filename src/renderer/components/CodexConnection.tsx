import { useEffect, useRef, useState } from "react";
import type { CodexModel, CodexStatus } from "../../shared/codex";
import { codexQuotaError } from "../../shared/codex";

export function CodexConnection({
  model,
  onModel,
}: {
  model: string;
  onModel: (model: string) => void;
}) {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const refresh = async () => {
    const id = ++generation.current;
    const next = await window.bunny.codexStatus({});
    if (id !== generation.current) return;
    setStatus(next);
    setModels([]);
    if (next.state === "connected") {
      const catalog = await window.bunny.codexModels({});
      if (id === generation.current) setModels(catalog);
    }
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
    unavailable: "Codex CLI를 찾을 수 없습니다",
    signedOut: "로그인 필요",
    signingIn: "브라우저에서 로그인 중",
    connected: "연결됨",
    error: "연결 확인 필요",
  };
  const selected = model || models.find((m) => m.isDefault)?.id || "";
  const quotaError =
    status?.state === "connected" ? codexQuotaError(status, selected) : null;
  return (
    <div className="codex-connection">
      <p role="status">
        {status ? labels[status.state] : "Codex 연결 확인 중…"}
        {status?.plan ? ` · ${status.plan}` : ""}
      </p>
      <div className="inline-actions">
        {status?.state !== "connected" && status?.state !== "signingIn" && (
          <button
            disabled={busy}
            onClick={() => void action(() => window.bunny.codexLogin({}))}
          >
            ChatGPT로 로그인
          </button>
        )}
        {status?.state === "signingIn" && (
          <button
            disabled={busy}
            onClick={() => void action(() => window.bunny.codexCancelLogin({}))}
          >
            로그인 취소
          </button>
        )}
        {(status?.state === "connected" || status?.state === "error") && (
          <button
            disabled={busy}
            onClick={() => void action(() => window.bunny.codexLogout({}))}
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
          <option value="">
            계정 기본 모델
            {models.find((m) => m.isDefault)
              ? ` · ${models.find((m) => m.isDefault)!.id}`
              : ""}
          </option>
          {model && !models.some((m) => m.id === model) && (
            <option value={model}>{model} · 사용 가능 여부 확인 필요</option>
          )}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </label>
      {status?.quotas.map((q) => (
        <div key={q.id} className="subtle">
          <strong>{q.name}</strong>
          {[q.primary, q.secondary].map(
            (w, i) =>
              w && (
                <p key={i}>
                  {w.windowDurationMins
                    ? `${w.windowDurationMins / 60}시간 한도`
                    : "사용 한도"}
                  : {Math.max(0, 100 - w.usedPercent).toFixed(0)}% 남음
                  {w.resetsAt
                    ? ` · 갱신 ${new Date(w.resetsAt * 1000).toLocaleString()}`
                    : ""}
                </p>
              ),
          )}
        </div>
      ))}
      {(error || status?.error || quotaError) && (
        <p className="notice" role="alert">
          {error || status?.error || quotaError}
        </p>
      )}
      <p className="subtle">
        다른 앱과 계정 한도를 공유합니다. 한도를 확인할 수 없거나 소진되면
        중단하며, 유료 API로 자동 전환하지 않습니다. 사전 확인은 계정 전체의
        추가 과금을 차단하는 설정은 아닙니다.
      </p>
    </div>
  );
}
