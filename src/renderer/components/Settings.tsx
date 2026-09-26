import { useState } from "react";
import { ExternalLink, ShieldCheck, Database, RefreshCw } from "lucide-react";
import type { Settings as SettingsValue } from "../../shared/types";
import { Modal } from "./Modal";
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
    <Modal title="설정" onClose={onClose} wide>
      <div className="settings-grid">
        <section>
          <h3>검색 서비스</h3>
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
              onChange={(e) => setOa(e.target.value)}
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
                        provider: "openalex",
                      })
                    ).message,
                  );
                })
              }
              disabled={busy}
            >
              연결 확인
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
            <button className="text-button" onClick={() => setOa("")}>
              키 삭제 예약
            </button>
          </div>
          <h3>
            핵심 논문 찾기 <span className="badge">실험</span>
          </h3>
          <label className="check">
            <input
              type="checkbox"
              checked={value.aiEnabled}
              onChange={(e) =>
                setValue({ ...value, aiEnabled: e.target.checked })
              }
            />
            OpenAI 추천 사용
          </label>
          <p className="subtle">
            실행하면 연구 질문과 확인된 후보의 제목·초록을 OpenAI에 전송합니다.
            PDF 전문과 비공개 노트는 전송하지 않습니다.
          </p>
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
              onChange={(e) => setValue({ ...value, model: e.target.value })}
            />
          </label>
          <div className="inline-actions">
            <button
              onClick={() =>
                void run(async () => {
                  await save();
                  setStatus(
                    (await window.bunny.testConnection({ provider: "openai" }))
                      .message,
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
                  setValue({ ...value, aiBudgetUsd: Number(e.target.value) })
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
        </section>
        <section>
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
          <h3>백업과 복원</h3>
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
              백업을 별도 라이브러리로 열기
            </button>
          </div>
          <p className="subtle">
            DB·관계·노트·선택 첨부를 포함합니다. 복원 후에도 기존 라이브러리를
            유지합니다. API 키는 백업하지 않습니다.
          </p>
          <h3>화면</h3>
          <select
            aria-label="테마"
            value={value.theme}
            onChange={(e) =>
              setValue({
                ...value,
                theme: e.target.value as SettingsValue["theme"],
              })
            }
          >
            <option value="system">시스템 설정</option>
            <option value="light">라이트</option>
            <option value="dark">다크</option>
          </select>
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
          <p className="subtle">
            ResearchBunny {settings.version} · 로컬 시험판
          </p>
        </section>
      </div>
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}
      <footer className="modal-footer">
        <button onClick={onClose}>닫기</button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void run(save)}
        >
          {busy ? "처리 중…" : "설정 저장"}
        </button>
      </footer>
    </Modal>
  );
}
