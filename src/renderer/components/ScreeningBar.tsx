import { useState } from "react";
import { Archive, LoaderCircle, Settings2, ShieldCheck, Square } from "lucide-react";
import { PURPOSE_NAMES, RECOMMENDATION_NAMES, type Recommendation, type ScreeningPurpose, type ScreeningSnapshot, type ScreeningTarget } from "../../shared/screening";

/**
 * The screening controls above a list: the purpose in force, screening the
 * list (or the selection), and archiving the papers recommended for inclusion,
 * which happens only when the person asks.
 */
export function ScreeningBar({ projectId, state, target, targetLabel, selected, canAccept, busy, onOpen, onChanged, onNotice, onError }: {
  projectId: string;
  state: ScreeningSnapshot;
  /** What "this list" means here; null where the list cannot be screened as a whole. */
  target: ScreeningTarget | null;
  targetLabel: string;
  selected: string[];
  /** Runs and review lists can archive recommendations; the archive itself cannot. */
  canAccept: boolean;
  busy: boolean;
  onOpen: () => void;
  onChanged: (state: ScreeningSnapshot) => void;
  onNotice: (text: string) => void;
  onError: (error: unknown) => void;
}) {
  const [working, setWorking] = useState(false);
  const job = state.job;
  const running = job?.status === "running";
  const screenTarget: ScreeningTarget | null = selected.length ? { kind: "ids", ids: selected } : target;
  const ready = state.profile.mode === "generative" ? state.ready.generative : state.profile.mode === "decision" ? state.ready.decision : state.ready.decision && state.ready.generative;
  const start = () => {
    if (!screenTarget) return;
    if (!ready) {
      onOpen();
      return;
    }
    setWorking(true);
    void window.bunny
      .screeningStart({ projectId, target: screenTarget })
      .then((started) => onChanged({ ...state, job: started }))
      .catch(onError)
      .finally(() => setWorking(false));
  };
  const accept = async () => {
    const acceptTarget = selected.length ? { kind: "ids" as const, ids: selected } : target;
    if (!acceptTarget) return;
    setWorking(true);
    try {
      const preview = await window.bunny.screeningAccept({ projectId, target: acceptTarget, preview: true });
      if (!preview.ids.length) {
        onNotice("아카이브에 담을 포함 추천 논문이 없습니다. 이미 담았거나 기준이 바뀐 판정은 빠집니다.");
        return;
      }
      if (!window.confirm(`포함 추천 ${preview.ids.length}편을 아카이브에 담습니다. 되돌리기로 취소할 수 있습니다.`)) return;
      const done = await window.bunny.screeningAccept({ projectId, target: acceptTarget, preview: false });
      onNotice(`포함 추천 ${done.ids.length}편을 아카이브에 담았습니다.`);
    } catch (cause) {
      onError(cause);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className={`screening-bar ${job?.status === "failed" ? "failed" : ""}`} role="group" aria-label="AI 심사">
      <span className="screening-title"><ShieldCheck size={14} /> AI 심사</span>
      <select aria-label="심사 목적" value={state.profile.purpose} disabled={running || busy}
        title="목적을 바꾸면 주제 판정은 그대로 두고 목적별 역할만 다시 봅니다."
        onChange={(e) => void window.bunny.screeningSave({ projectId, profile: { purpose: e.target.value as ScreeningPurpose } }).then(onChanged).catch(onError)}>
        {(Object.keys(PURPOSE_NAMES) as ScreeningPurpose[]).map((p) => (
          <option key={p} value={p}>{p === "custom" && state.profile.custom.label ? state.profile.custom.label : PURPOSE_NAMES[p]}</option>
        ))}
      </select>
      <button className="icon-button" title="심사 기준·목적·정확도 평가" aria-label="심사 기준" onClick={onOpen}><Settings2 size={15} /></button>
      {running ? (
        <>
          <span className="screening-status" role="status"><LoaderCircle size={13} className="spin" /> {job.message}</span>
          <button className="icon-button" title={job.kind === "evaluate" ? "평가 취소" : "심사 취소"} aria-label="심사 취소"
            onClick={() => void window.bunny.screeningCancel({ projectId }).catch(onError)}><Square size={13} /></button>
        </>
      ) : (
        <>
          <button disabled={working || busy || !screenTarget}
            title={!state.profile.include.length && !state.profile.exclude.length ? "기준 없이도 연구 의도와의 관련성으로 심사합니다. 기준을 정하면 더 정확합니다." : "기준에 따라 포함·보류·제외를 추천합니다. 아카이브에는 담지 않습니다."}
            onClick={start}>
            {selected.length ? `선택 ${selected.length}편 심사` : `${targetLabel} 심사`}
          </button>
          {canAccept && (
            <button disabled={working || busy} onClick={() => void accept()} title="포함 추천 논문만 아카이브에 담습니다.">
              <Archive size={14} /> 포함 추천 담기
            </button>
          )}
          {job && job.status !== "running" && (
            <span className={`screening-status ${job.status}`} title={job.message}>
              {state.live && job.status === "completed"
                // Recomputed from the stored judgments, so a changed rule or purpose shows here at once.
                ? `${job.target === "run" ? "후보" : job.target === "archive" ? "아카이브" : "심사한 논문"} · ${(Object.keys(RECOMMENDATION_NAMES) as Recommendation[]).map((r) => `${RECOMMENDATION_NAMES[r]} ${state.live!.counts[r]}편`).join(" · ")}${state.live.stale ? ` · 기준 변경 전 ${state.live.stale}편` : ""}${state.live.unscreened ? ` · 미심사 ${state.live.unscreened}편` : ""}`
                : job.message}
            </span>
          )}
        </>
      )}
    </div>
  );
}
