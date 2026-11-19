import { useState } from "react";
import { LoaderCircle, Plus, Sparkles, Square, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import {
  DECISION_MODELS,
  INCLUDE_MODE_NAMES,
  MODE_NAMES,
  PURPOSE_NAMES,
  PURPOSE_QUESTIONS,
  type Criterion,
  type IncludeMode,
  type RoleQuestion,
  type ScreeningMode,
  type ScreeningProfile,
  type ScreeningPurpose,
  type ScreeningSnapshot,
} from "../../shared/screening";

let draftId = 0;
const newId = () => `n${Date.now().toString(36)}${draftId++}`;

function CriterionList({ label, items, onChange, placeholder }: { label: string; items: Criterion[]; onChange: (items: Criterion[]) => void; placeholder: string }) {
  return (
    <fieldset className="criterion-list">
      <legend>{label}</legend>
      {items.map((item, index) => (
        <div className="criterion-row" key={item.id}>
          <span className="criterion-number">{index + 1}</span>
          <input
            aria-label={`${label} ${index + 1}`}
            value={item.text}
            maxLength={500}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((c) => (c.id === item.id ? { ...c, text: e.target.value } : c)))}
          />
          <button type="button" className="icon-button" title="기준 빼기" aria-label={`${label} ${index + 1} 빼기`} onClick={() => onChange(items.filter((c) => c.id !== item.id))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button type="button" className="text-button" disabled={items.length >= 20} onClick={() => onChange([...items, { id: newId(), text: "" }])}>
        <Plus size={13} /> 기준 추가
      </button>
    </fieldset>
  );
}

/** A project's screening criteria and purpose, an AI draft of them, and the accuracy check. */
export function ScreeningDialog({ projectId, state, onClose, onSaved, onError }: {
  projectId: string;
  state: ScreeningSnapshot;
  onClose: () => void;
  onSaved: (state: ScreeningSnapshot) => void;
  onError: (error: unknown) => void;
}) {
  const [form, setForm] = useState<ScreeningProfile>(state.profile);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [size, setSize] = useState(40);
  const job = state.job;
  const evaluating = job?.kind === "evaluate" && job.status === "running";
  const screening = job?.kind === "screen" && job.status === "running";
  const set = <K extends keyof ScreeningProfile>(key: K, value: ScreeningProfile[K]) => setForm((f) => ({ ...f, [key]: value }));
  const changedCriteria =
    form.intent.trim() !== state.profile.intent.trim() ||
    JSON.stringify(form.include.map((c) => c.text.trim())) !== JSON.stringify(state.profile.include.map((c) => c.text)) ||
    JSON.stringify(form.exclude.map((c) => c.text.trim())) !== JSON.stringify(state.profile.exclude.map((c) => c.text));
  const save = async () => {
    setSaving(true);
    try {
      const saved = await window.bunny.screeningSave({
        projectId,
        profile: {
          purpose: form.purpose,
          custom: form.custom,
          intent: form.intent,
          include: form.include.filter((c) => c.text.trim()),
          includeMode: form.includeMode ?? "any",
          exclude: form.exclude.filter((c) => c.text.trim()),
          suggestions: form.suggestions,
          mode: form.mode,
          decisionModel: form.decisionModel,
        },
      });
      onSaved(saved);
      return saved;
    } catch (cause) {
      onError(cause);
      return null;
    } finally {
      setSaving(false);
    }
  };
  const draft = async () => {
    setDrafting(true);
    setDraftNote("");
    try {
      const result = await window.bunny.screeningDraft({ projectId });
      setForm((f) => ({
        ...f,
        intent: result.intent,
        include: result.include.map((text) => ({ id: newId(), text })),
        exclude: result.exclude.map((text) => ({ id: newId(), text })),
        includeMode: "any",
      }));
      setDraftNote(`AI 초안: ${result.basis}. 포함 기준만 만들었습니다(하나라도 맞으면 포함). 제외 기준은 동물 연구처럼 꼭 빼야 할 것만 직접 추가하세요. 고친 뒤 저장하세요.`);
    } catch (cause) {
      onError(cause);
    } finally {
      setDrafting(false);
    }
  };
  const customQuestions = form.custom.questions;
  const setQuestions = (questions: RoleQuestion[]) => set("custom", { ...form.custom, questions });
  const report = state.evaluation;
  return (
    <Modal title="AI 심사 기준" onClose={onClose} wide>
      <div className="screening-dialog">
        <p className="subtle">
          AI는 추천만 하고 아카이브에 담는 것은 직접 합니다. 심사하면 연구 의도·기준과 논문의 제목·초록을 결정 모델(Ollama Cloud)과 설정에서 고른 AI 연결로 보냅니다.
          메모와 태그는 보내지 않습니다. 의도나 기준을 바꾸면 이전 판정은 ‘기준 변경 전’으로 표시됩니다.
        </p>
        <div className="inline-actions">
          <button className="secondary" disabled={drafting || !state.ready.generative} onClick={() => void draft()}
            title={state.ready.generative ? "연구 질문, 초기 관심 문헌, 지금까지 담고 버린 논문으로 의도와 기준의 초안을 만듭니다." : "설정에서 AI 연결을 고르고 AI 추천·분류를 켜야 합니다."}>
            {drafting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
            {drafting ? "초안 만드는 중…" : "AI 초안 만들기"}
          </button>
          {draftNote && <span className="subtle">{draftNote}</span>}
        </div>
        <label className="field">
          심사 목적
          <select value={form.purpose} onChange={(e) => set("purpose", e.target.value as ScreeningPurpose)}>
            {(Object.keys(PURPOSE_NAMES) as ScreeningPurpose[]).map((p) => <option key={p} value={p}>{PURPOSE_NAMES[p]}</option>)}
          </select>
        </label>
        {form.purpose !== "custom" ? (
          <p className="subtle">
            주제 관련성과 별도로, 이 목적에서 맡을 역할이 있는지 묻습니다: {PURPOSE_QUESTIONS[form.purpose].map((q) => q.label).join(" · ")}.
            주제는 맞지만 역할이 없는 논문은 제외가 아니라 보류가 됩니다. 목적을 바꿔도 주제 판정은 다시 하지 않습니다.
          </p>
        ) : (
          <fieldset className="criterion-list">
            <legend>직접 정의한 목적</legend>
            <input aria-label="목적 이름" placeholder="예: 원고의 방법 절" value={form.custom.label} maxLength={80} onChange={(e) => set("custom", { ...form.custom, label: e.target.value })} />
            {customQuestions.map((q, index) => (
              <div className="criterion-row" key={q.id}>
                <span className="criterion-number">{index + 1}</span>
                <input aria-label={`역할 질문 ${index + 1}`} value={q.question} maxLength={500} placeholder="이 논문이 …을 제시하는가?"
                  onChange={(e) => setQuestions(customQuestions.map((c) => (c.id === q.id ? { ...c, question: e.target.value, label: e.target.value.slice(0, 40) } : c)))} />
                <button type="button" className="icon-button" aria-label={`역할 질문 ${index + 1} 빼기`} onClick={() => setQuestions(customQuestions.filter((c) => c.id !== q.id))}><Trash2 size={14} /></button>
              </div>
            ))}
            <button type="button" className="text-button" disabled={customQuestions.length >= 12} onClick={() => setQuestions([...customQuestions, { id: newId(), label: "", question: "" }])}>
              <Plus size={13} /> 역할 질문 추가
            </button>
          </fieldset>
        )}
        <label className="field">
          연구 의도
          <textarea rows={3} maxLength={2000} value={form.intent} placeholder="무엇을 알고 싶은지, 무엇은 원하지 않는지 두세 문장"
            onChange={(e) => set("intent", e.target.value)} />
        </label>
        <CriterionList label="포함 기준" items={form.include} onChange={(items) => set("include", items)} placeholder="예: 치료 저항성 조현병 환자를 대상으로 한 연구" />
        <label className="field inline-field">
          포함 기준을
          <select value={form.includeMode ?? "any"} onChange={(e) => set("includeMode", e.target.value as IncludeMode)}>
            {(Object.keys(INCLUDE_MODE_NAMES) as IncludeMode[]).map((m) => <option key={m} value={m}>{INCLUDE_MODE_NAMES[m]}</option>)}
          </select>
          <span className="subtle">{(form.includeMode ?? "any") === "any" ? "기준마다 원하는 논문의 한 종류를 적습니다. 하나에 분명히 맞으면 포함, 모두에 분명히 맞지 않을 때만 제외합니다." : "체계적 고찰처럼 모든 기준(대상·중재·설계…)을 갖춰야 포함하고, 하나라도 분명히 어기면 제외합니다."}</span>
        </label>
        <CriterionList label="제외 기준 (선택)" items={form.exclude} onChange={(items) => set("exclude", items)} placeholder="예: 동물 실험이나 세포 연구" />
        <p className="subtle">제외 기준은 포함 기준에 맞아도 꼭 빼야 할 것만 적습니다. 분명히 해당할 때만 제외하고, 포함 기준을 뒤집은 문장은 필요 없습니다.</p>
        {form.suggestions.length > 0 && (
          <fieldset className="criterion-list suggestions">
            <legend>거절한 추천에서 나온 제외 기준 후보</legend>
            {form.suggestions.map((s) => (
              <div className="criterion-row" key={s.id}>
                <span>{s.text}</span>
                <button type="button" className="text-button" onClick={() => setForm((f) => ({ ...f, exclude: [...f.exclude, { id: newId(), text: s.text }], suggestions: f.suggestions.filter((x) => x.id !== s.id) }))}>제외 기준에 추가</button>
                <button type="button" className="text-button" onClick={() => set("suggestions", form.suggestions.filter((x) => x.id !== s.id))}>버리기</button>
              </div>
            ))}
          </fieldset>
        )}
        <div className="filter-row">
          <label className="field">
            판정 방식
            <select value={form.mode} onChange={(e) => set("mode", e.target.value as ScreeningMode)}>
              {(Object.keys(MODE_NAMES) as ScreeningMode[]).map((m) => <option key={m} value={m}>{MODE_NAMES[m]}</option>)}
            </select>
          </label>
          <label className="field">
            결정 모델
            <select value={form.decisionModel} disabled={form.mode === "generative"} onChange={(e) => set("decisionModel", e.target.value)}>
              {[...new Set([...DECISION_MODELS, form.decisionModel])].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
        </div>
        <p className="subtle">
          결정 모델은 기준마다 참일 확률을 돌려주고, 애매한 논문과 포함 추천의 이유는 생성 모델이 씁니다. 제외는 초록이 기준을 분명히 어길 때만 추천하고,
          판정 실패나 초록 없음은 보류로 둡니다.
          {!state.ready.decision && " 결정 모델을 쓰려면 설정에서 Ollama Cloud API 키를 등록하세요."}
          {!state.ready.generative && " 생성 모델을 쓰려면 설정에서 AI 추천·분류를 켜세요."}
        </p>
        <section className="screening-evaluation">
          <h3>정확도 평가</h3>
          <p className="subtle">
            이 프로젝트의 아카이브(관련 있음)와 휴지통·제외 문헌(관련 없음)으로 세 판정 방식을 비교합니다. 관련 논문을 놓치는 비율이 5% 이하여야 통과입니다.
            지금 저장된 기준으로 평가합니다{changedCriteria ? " — 고친 기준을 먼저 저장하세요" : ""}.
          </p>
          <div className="inline-actions">
            <label>
              그룹당{" "}
              <select aria-label="평가 표본 크기" value={size} onChange={(e) => setSize(Number(e.target.value))}>
                {[20, 40, 80, 150].map((n) => <option key={n} value={n}>{n}편</option>)}
              </select>
            </label>
            {evaluating ? (
              <button className="secondary" onClick={() => void window.bunny.screeningCancel({ projectId }).catch(onError)}><Square size={13} /> 평가 취소</button>
            ) : (
              <button className="secondary" disabled={screening || changedCriteria || (!state.ready.decision && !state.ready.generative)}
                onClick={() => void window.bunny.screeningEvaluate({ projectId, size }).then(() => onSaved({ ...state, job: { kind: "evaluate", status: "running", message: "평가 준비", done: 0, total: 0, updatedAt: new Date().toISOString() } })).catch(onError)}>
                평가 실행
              </button>
            )}
            {job?.kind === "evaluate" && <span className={job.status === "failed" ? "warning-text" : "subtle"} role="status">{job.message}</span>}
          </div>
          {report && (
            <>
              <table className="evaluation-table">
                <thead>
                  <tr><th>판정 방식</th><th>놓친 관련 논문</th><th>걸러낸 무관 논문</th><th>보류</th><th>호출 (결정/생성)</th><th>결과</th></tr>
                </thead>
                <tbody>
                  {report.scores.map((s) => (
                    <tr key={s.mode}>
                      <td>{s.label}</td>
                      {s.error ? <td colSpan={5} className="warning-text">{s.error}</td> : <>
                        <td>{s.missed}/{s.relevant} ({(s.missRate * 100).toFixed(1)}%)</td>
                        <td>{s.caught}/{s.irrelevant}</td>
                        <td>{s.maybe}</td>
                        <td>{s.calls.decision}/{s.calls.generative}</td>
                        <td className={s.passed ? "green" : "warning-text"}>{s.passed ? "통과" : "미달"}</td>
                      </>}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="subtle">
                {new Date(report.createdAt).toLocaleString()} · 기준 v{report.criteriaVersion}{report.criteriaVersion !== state.profile.version ? " (지금 기준과 다름)" : ""} · 표본 {report.sample.relevant}+{report.sample.irrelevant}편.{" "}
                {report.recommended ? <>권장: <button className="text-button" onClick={() => set("mode", report.recommended!)}>{MODE_NAMES[report.recommended]}</button></> : "통과한 방식이 없습니다. 기준을 다듬거나 생성 모델만 쓰세요."}
              </p>
            </>
          )}
        </section>
      </div>
      <div className="modal-footer">
        <button onClick={onClose}>닫기</button>
        <button className="primary" disabled={saving || screening} onClick={() => void save().then((saved) => saved && onClose())}>
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
    </Modal>
  );
}
