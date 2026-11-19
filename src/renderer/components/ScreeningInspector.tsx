import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { WorkView } from "../../shared/types";
import {
  CHARACTER_TYPES,
  CONTRIBUTIONS,
  RECOMMENDATION_NAMES,
  type CharacterType,
  type Contribution,
} from "../../shared/screening";

const percent = (p: number) => `${Math.round(p * 100)}%`;
const VERDICTS = { yes: "예", no: "아니오", unclear: "불확실" } as const;

/** One paper's AI screening and its character, in the inspector. */
export function ScreeningInspector({ work, projectId, onNotice, onError }: {
  work: WorkView;
  projectId: string;
  onNotice: (text: string) => void;
  onError: (error: unknown) => void;
}) {
  const screen = work.screen;
  const character = work.character;
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setFeedback(""), [work.id]);
  const turnedDown = screen?.recommendation === "include" && ["trash", "excluded"].includes(work.state.screening);
  const rescreen = () => {
    setBusy(true);
    void window.bunny
      .screeningStart({ projectId, target: { kind: "ids", ids: [work.id] }, fresh: true })
      .then(() => onNotice("이 논문을 다시 심사합니다."))
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const setCharacter = (type: CharacterType | null, contributions: Contribution[]) =>
    void window.bunny.characterSet({ workId: work.id, type, contributions }).catch(onError);
  return (
    <section className="screen-card">
      <h3>
        AI 심사
        {screen && <span className={`screen-badge ${screen.recommendation}`}>{RECOMMENDATION_NAMES[screen.recommendation]}</span>}
      </h3>
      {!screen ? (
        <p className="subtle">아직 심사하지 않았습니다. 목록 위의 ‘AI 심사’로 이 목록을 심사하거나 이 논문만 심사하세요.</p>
      ) : (
        <>
          {screen.stale && <p className="warning-text">기준을 바꾸기 전의 판정입니다. 다시 심사하면 새 기준으로 판정합니다.</p>}
          {screen.basis === "none" && <p className="subtle">초록이 없어 모델에 묻지 않고 보류로 두었습니다.</p>}
          {screen.error && <p className="warning-text">판정 실패로 보류: {screen.error}</p>}
          {screen.roleMissing && <p className="subtle">지금 목적의 역할 질문은 아직 묻지 않았습니다. 다시 심사하면 그 질문만 묻습니다.</p>}
          {(screen.hits.length > 0 || screen.roleNote || screen.matched.length > 0) && (
            <ul className="evidence-list">
              {screen.hits.map((hit) => <li key={hit}>{hit}</li>)}
              {screen.roleNote && <li>{screen.roleNote}</li>}
              {screen.matched.map((m) => <li key={m} className="green">{m}</li>)}
            </ul>
          )}
          {screen.reason && <p>{screen.reason}</p>}
          {screen.quote && (
            <>
              <blockquote>{screen.quote}</blockquote>
              {!screen.quoteChecked && <small className="warning-text">이 인용문은 초록에서 찾지 못했습니다. 이유를 그대로 믿지 마세요.</small>}
            </>
          )}
          {screen.criteria.length > 0 && (
            <details>
              <summary>기준별 판정</summary>
              <ul className="criterion-judgments">
                {screen.criteria.map((c) => (
                  <li key={c.id}>
                    <strong>{c.label}</strong> {c.text}
                    <span className="subtle">
                      {c.p !== undefined ? ` · 확률 ${percent(c.p)}` : ""}
                      {c.verdict ? ` · 생성 모델 ${VERDICTS[c.verdict]}` : ""}
                      {c.p === undefined && !c.verdict ? " · 판정 없음" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {screen.roles.length > 0 && (
            <details>
              <summary>목적에서 맡을 역할</summary>
              <ul className="criterion-judgments">
                {screen.roles.map((r) => <li key={r.id}>{r.label} <span className="subtle">· {percent(r.value)}</span></li>)}
              </ul>
            </details>
          )}
          <p className="subtle">
            {screen.relevance !== null ? `관련성 ${screen.relevance.toFixed(1)}/4 · ` : ""}
            {[screen.models.decision && `결정 ${screen.models.decision}`, screen.models.generative && `생성 ${screen.models.generative}`].filter(Boolean).join(" · ") || "모델 호출 없음"}
            {" · "}{new Date(screen.screenedAt).toLocaleString()}
          </p>
        </>
      )}
      <div className="inline-actions">
        <button className="text-button" disabled={busy} onClick={rescreen}><RotateCcw size={13} /> 이 논문 {screen ? "다시 " : ""}심사</button>
      </div>
      {turnedDown && (
        <form className="screen-feedback" onSubmit={(e) => {
          e.preventDefault();
          if (!feedback.trim()) return;
          void window.bunny.screeningSuggest({ projectId, workId: work.id, reason: feedback })
            .then(() => { setFeedback(""); onNotice("제외 기준 후보로 남겼습니다. AI 심사 기준에서 추가할 수 있습니다."); })
            .catch(onError);
        }}>
          <label className="field">
            포함 추천을 거절했습니다. 이 논문은 왜 아닌가요?
            <input value={feedback} maxLength={300} placeholder="예: 동물 연구라서" onChange={(e) => setFeedback(e.target.value)} />
          </label>
          <button type="submit" disabled={!feedback.trim()}>제외 기준 후보로 남기기</button>
        </form>
      )}
      <h3>논문 성격</h3>
      <div className="character-row">
        <select aria-label="논문 유형" value={character?.type ?? ""}
          onChange={(e) => setCharacter((e.target.value || null) as CharacterType | null, character?.contributions ?? [])}>
          <option value="">유형 미정</option>
          {(Object.keys(CHARACTER_TYPES) as CharacterType[]).map((t) => <option key={t} value={t}>{CHARACTER_TYPES[t]}</option>)}
        </select>
        <span className="contribution-chips">
          {(Object.keys(CONTRIBUTIONS) as Contribution[]).map((c) => {
            const on = !!character?.contributions.includes(c);
            return (
              <button key={c} type="button" className={on ? "chip on" : "chip"} aria-pressed={on}
                onClick={() => setCharacter(character?.type ?? null, on ? character!.contributions.filter((x) => x !== c) : [...(character?.contributions ?? []), c])}>
                {CONTRIBUTIONS[c].label}
              </button>
            );
          })}
        </span>
      </div>
      <p className="subtle">
        {character ? `${character.source === "user" ? "직접 지정" : character.source === "metadata" ? "서지 기록" : "AI 판정"}${character.reason ? ` · ${character.reason}` : ""}` : "심사할 때 함께 판정합니다. 고르면 직접 지정한 값이 됩니다."}
      </p>
    </section>
  );
}
