import { CodexConnection } from "./CodexConnection";
import { useState } from "react";
import { ExternalLink, ShieldCheck, Database, RefreshCw, LoaderCircle, CircleCheck, CircleAlert } from "lucide-react";
import type { Settings as SettingsValue } from "../../shared/types";

type ConnectionCheck =
  | { state: "idle" | "checking" }
  | { state: "success" | "error"; message: string };

export function Settings({
  settings,
  onClose,
  onSaved,
  onError,
  onRestored,
}: {
  settings: SettingsValue;
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
  onRestored: () => void;
}) {
  const [value, setValue] = useState(settings),
    [oa, setOa] = useState<string | undefined>(),
    [ai, setAi] = useState<string | undefined>(),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [attachments, setAttachments] = useState(true),
    [linked, setLinked] = useState(false);
  const [openalexCheck, setOpenalexCheck] = useState<ConnectionCheck>({ state: "idle" });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    await window.bunny.saveSettings({
      model: value.model,
      aiProvider: value.aiProvider,
      codexModel: value.codexModel,
      aiEnabled: value.aiEnabled,
      theme: value.theme,
      aiMaxInputTokens: value.aiMaxInputTokens,
      aiMaxOutputTokens: value.aiMaxOutputTokens,
      aiBudgetUsd: value.aiBudgetUsd,
      inputPricePerMillion: value.inputPricePerMillion,
      outputPricePerMillion: value.outputPricePerMillion,
      ...(oa !== undefined ? { openalexKey: oa } : {}),
      ...(ai !== undefined ? { openaiKey: ai } : {}),
    });
    setOa(undefined);
    setAi(undefined);
    onSaved();
    setStatus("설정을 저장했습니다.");
  };
  return (
    <main className="settings-workspace">
      <div className="settings-content">
        <header>
          <h1>설정</h1>
          <p className="subtle">연결과 로컬 라이브러리를 관리하세요.</p>
        </header>
        <nav className="settings-navigation" aria-label="설정 섹션">
          <a href="#settings-connections">연결</a>
          <a href="#settings-library">라이브러리</a>
          <a href="#settings-appearance">화면</a>
        </nav>
        <div className="settings-grid">
          <section id="settings-connections" className="settings-group">
            <h3>문헌 검색</h3>
            <p className="subtle">
              OpenAlex · 검색과 인용 관계 탐색에 사용합니다.
            </p>
            <label className="field">
              OpenAlex API 키{" "}
              <span className="subtle">
                {settings.openalexConfigured
                  ? "등록됨"
                  : "미등록 · 제한된 검색 가능"}
              </span>
              <input
                type="password"
                autoComplete="off"
                placeholder="변경할 때만 입력"
                value={oa ?? ""}
                disabled={busy}
                onChange={(e) => {
                  setOa(e.target.value);
                  setOpenalexCheck({ state: "idle" });
                }}
              />
            </label>
            <div className="inline-actions">
              <button
                onClick={() =>
                  void run(async () => {
                    setOpenalexCheck({ state: "checking" });
                    try {
                      await save();
                      const result = await window.bunny.testConnection({
                          provider: "openalex",
                      });
                      setOpenalexCheck({ state: "success", message: result.message });
                    } catch (error) {
                      setOpenalexCheck({ state: "error", message: error instanceof Error ? error.message : "연결을 확인하지 못했습니다. 다시 시도해 주세요." });
                    }
                  })
                }
                disabled={busy}
                aria-busy={openalexCheck.state === "checking"}
              >
                {openalexCheck.state === "checking" && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
                {openalexCheck.state === "checking" ? "확인 중…" : "연결 확인"}
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void window.bunny
                    .openExternal({ kind: "openalex-settings" })
                    .catch(onError)
                }
              >
                무료 키 발급 <ExternalLink size={12} />
              </button>
              <button className="text-button" disabled={busy} onClick={() => {
                setOa("");
                setOpenalexCheck({ state: "idle" });
              }}>
                키 삭제 예약
              </button>
            </div>
            <div className={`connection-feedback ${openalexCheck.state}`} role="status" aria-live="polite" aria-atomic="true">
              {openalexCheck.state === "checking" && <span>OpenAlex 연결을 확인하고 있습니다.</span>}
              {openalexCheck.state === "success" && <><CircleCheck size={16} aria-hidden="true" /><span>연결 성공 · {openalexCheck.message}</span></>}
              {openalexCheck.state === "error" && <><CircleAlert size={16} aria-hidden="true" /><span>연결 확인 실패 · {openalexCheck.message}</span></>}
            </div>
          </section>
          <section className="settings-group">
            <h3>
              AI 추천·분류 <span className="badge">선택 기능</span>
            </h3>
            <label className="check ai-toggle">
              <input
                role="switch"
                type="checkbox"
                checked={value.aiEnabled}
                onChange={(e) =>
                  setValue({ ...value, aiEnabled: e.target.checked })
                }
              />
              AI 추천·분류 사용
            </label>
            <p className="subtle">
              실행하면 연구 질문과 대상 논문의 제목·초록·주제 정보를 선택한 AI 연결로
              전송합니다. PDF 전문과 비공개 노트는 전송하지 않습니다.
            </p>
            <label className="field">AI 연결 방식
              <select value={value.aiProvider} onChange={e => setValue({ ...value, aiProvider: e.target.value === "openai" ? "openai" : "codex" })}>
                <option value="codex">Codex (ChatGPT subscription)</option>
                <option value="openai">OpenAI API · 별도 API 과금</option>
              </select>
            </label>
            {value.aiProvider === "codex" ? <>
              <CodexConnection model={value.codexModel} onModel={codexModel => setValue(current => ({ ...current, codexModel }))} />
              <label className="field">실행당 입력 토큰 예산
                <input type="number" min="1000" max="100000" value={value.aiMaxInputTokens} onChange={e => setValue({ ...value, aiMaxInputTokens: Number(e.target.value) })} />
              </label>
              <p className="subtle">실행당 최대 3회 호출. Codex 연결은 응답 토큰 상한·달러 예산을 지원하지 않으며, 구독 허용 상태를 매번 확인합니다.</p>
            </> : <details className="settings-advanced">
              <summary>모델과 사용 한도 · API 키</summary>
              <label className="field">
                OpenAI API 키{" "}
                <span className="subtle">
                  {settings.openaiConfigured ? "등록됨" : "미등록"}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="변경할 때만 입력"
                  value={ai ?? ""}
                  onChange={(e) => setAi(e.target.value)}
                />
              </label>
              <label className="field">
                모델 ID
                <input
                  value={value.model}
                  onChange={(e) =>
                    setValue({ ...value, model: e.target.value })
                  }
                />
              </label>
              <div className="inline-actions">
                <button
                  onClick={() =>
                    void run(async () => {
                      await save();
                      setStatus(
                        (
                          await window.bunny.testConnection({
                            provider: "openai",
                          })
                        ).message,
                      );
                    })
                  }
                  disabled={busy}
                >
                  모델 접근 확인
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void window.bunny
                      .openExternal({ kind: "openai-settings" })
                      .catch(onError)
                  }
                >
                  API 키 관리 <ExternalLink size={12} />
                </button>
                <button className="text-button" onClick={() => setAi("")}>
                  키 삭제 예약
                </button>
              </div>
              <div className="form-grid">
                <label className="field">
                  입력 토큰 상한
                  <input
                    type="number"
                    min="1000"
                    max="100000"
                    value={value.aiMaxInputTokens}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        aiMaxInputTokens: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  응답 토큰 상한
                  <input
                    type="number"
                    min="500"
                    max="16000"
                    value={value.aiMaxOutputTokens}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        aiMaxOutputTokens: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  실행당 예산 (USD)
                  <input
                    type="number"
                    min="0.01"
                    step="0.05"
                    value={value.aiBudgetUsd}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        aiBudgetUsd: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  입력 / 출력 $ · 100만 토큰
                  <div className="input-pair">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={value.inputPricePerMillion}
                      onChange={(e) =>
                        setValue({
                          ...value,
                          inputPricePerMillion: Number(e.target.value),
                        })
                      }
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={value.outputPricePerMillion}
                      onChange={(e) =>
                        setValue({
                          ...value,
                          outputPricePerMillion: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </label>
              </div>
              <p className="subtle">
                최대 3회 호출. 금액 제한은 입력한 단가로 보수적으로 계산합니다.
                모델을 바꾸면 공식 요금에 맞춰 단가를 수정하세요.
              </p>
            </details>}
          </section>
          <section id="settings-library" className="settings-group">
            <h3>
              <Database size={16} /> 로컬 라이브러리
            </h3>
            <p className="path">{settings.dataPath}</p>
            <button
              onClick={() =>
                void window.bunny
                  .openExternal({ kind: "data-folder" })
                  .catch(onError)
              }
            >
              Finder에서 열기
            </button>
            <details className="settings-advanced backup-options">
              <summary>백업에 포함할 파일</summary>
              <label className="check">
                <input
                  type="checkbox"
                  checked={attachments}
                  onChange={(e) => setAttachments(e.target.checked)}
                />
                관리 PDF 포함
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={linked}
                  onChange={(e) => setLinked(e.target.checked)}
                />
                외부 연결 PDF도 포함
              </label>
            </details>
            <div className="stack-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await window.bunny.backup({
                      includeAttachments: attachments,
                      includeLinked: linked,
                    });
                    if (r)
                      setStatus(
                        `백업 완료: ${r.path}${r.missing.length ? ` · 첨부 제외/누락 ${r.missing.length}개: ${r.missing.join(", ")}` : ""}`,
                      );
                  })
                }
              >
                백업 폴더 만들기
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await window.bunny.restoreBackup({});
                    if (r) {
                      setStatus(
                        `별도 라이브러리에 복원 완료${r.missing.length ? ` · 첨부 ${r.missing.length}개 재연결 필요` : ""}`,
                      );
                      onRestored();
                    }
                  })
                }
              >
                <RefreshCw size={14} />
                백업 복원
              </button>
            </div>
            <p className="subtle">
              문헌·노트·선택 첨부를 백업합니다. 복원은 별도 라이브러리로 열며
              API 키는 포함하지 않습니다.
            </p>
          </section>
          <section id="settings-appearance" className="settings-group">
            <h3>화면</h3>
            <div className="theme-options" role="group" aria-label="테마">
              {(
                [
                  ["system", "시스템"],
                  ["light", "밝게"],
                  ["dark", "어둡게"],
                ] as const
              ).map(([theme, label]) => (
                <button
                  key={theme}
                  aria-pressed={value.theme === theme}
                  className={value.theme === theme ? "active" : ""}
                  onClick={() => setValue({ ...value, theme })}
                >
                  <span className={`theme-preview ${theme}`} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <details className="settings-advanced">
              <summary>API 사용과 보안 저장소</summary>
              <h3>누적 API 사용</h3>
              {settings.usage.length ? (
                settings.usage.map((u) => (
                  <p className="subtle" key={u.provider}>
                    {u.provider}: {u.calls}회 · 입력{" "}
                    {u.inputTokens.toLocaleString()} / 출력{" "}
                    {u.outputTokens.toLocaleString()} 토큰
                  </p>
                ))
              ) : (
                <p className="subtle">아직 사용 기록이 없습니다.</p>
              )}
              <div className="security-note">
                <ShieldCheck size={18} />
                <span>
                  {settings.secureStorage === null
                    ? "키 저장 시 macOS 보안 저장소를 확인합니다. 키체인 접근 확인 창이 나타날 수 있습니다."
                    : settings.secureStorage
                      ? "키는 macOS 보안 저장소로 암호화합니다."
                      : "macOS 보안 저장소를 사용할 수 없습니다. 키 저장이 차단됩니다."}
                </span>
              </div>
            </details>
            <p className="subtle">
              ResearchBunny {settings.version} · 로컬 라이브러리
            </p>
          </section>
        </div>
        {settings.credentialMigrationRequired && <p className="notice" role="status">
          Electron 버전의 API 키는 다시 입력해 주세요. 기존 암호화 파일과 문헌은 보존되어 있으며, 새 키는 macOS 키체인에 저장됩니다.
        </p>}
        {status && (
          <p className="notice" role="status">
            {status}
          </p>
        )}
        <footer className="modal-footer">
          <button onClick={onClose}>취소</button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void run(save)}
          >
            {busy ? "처리 중…" : "설정 저장"}
          </button>
        </footer>
      </div>
    </main>
  );
}
