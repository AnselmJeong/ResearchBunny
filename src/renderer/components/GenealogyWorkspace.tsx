import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, FolderOpen, LoaderCircle, Pause, Play, Square, Trash2, TriangleAlert } from "lucide-react";
import {
  ORIGINS,
  PAPER_TYPES,
  STEPS,
  STEP_NAMES,
  TEXT_BASIS,
  type GenealogySettings,
  type GenealogyStep,
  type GenealogyView,
  type PaperType,
} from "../../shared/genealogy";
import { GenealogySettingsForm } from "./GenealogySettingsForm";

type Tab = "papers" | "settings";
const TABS: { key: Tab; label: string }[] = [
  { key: "papers", label: "문헌" },
  { key: "settings", label: "설정" },
];

const STATUS_NAMES = { running: "진행 중", paused: "일시정지", failed: "실패", completed: "완료", cancelled: "취소됨", interrupted: "중단됨" } as const;

function Steps({ view, busy, onRun }: { view: GenealogyView; busy: boolean; onRun: (step: GenealogyStep) => void }) {
  const { genealogy: g } = view;
  return (
    <ol className="genealogy-steps">
      {STEPS.map((step) => {
        const current = g.job?.step === step && g.job.status === "running";
        const done = !!g.completed[step];
        return (
          <li key={step} className={current ? "current" : done ? "done" : ""}>
            <span className="genealogy-step-icon">
              {current ? <LoaderCircle size={14} className="spin" /> : done ? <Check size={14} /> : <CircleDashed size={14} />}
            </span>
            <span className="genealogy-step-name">{STEP_NAMES[step]}</span>
            <button className="text-button" disabled={busy} title={`${STEP_NAMES[step]}만 실행`} onClick={() => onRun(step)}>
              {done ? "다시" : "실행"}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Papers({ view, onType }: { view: GenealogyView; onType: (workId: string, type: PaperType) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const papers = view.papers.filter((p) => p.included);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of papers) c[p.basis] = (c[p.basis] || 0) + 1;
    return c;
  }, [papers]);
  if (!papers.length) return <p className="subtle">컬렉션에 문헌이 없습니다.</p>;
  return (
    <>
      <p className="subtle">
        {papers.length}편 · {Object.entries(counts).map(([k, n]) => `${TEXT_BASIS[k as keyof typeof TEXT_BASIS]} ${n}`).join(" · ")}. 유형을 바꾸면 그 논문의 카드를 다시 만듭니다.
      </p>
      <table className="genealogy-table">
        <thead>
          <tr>
            <th>연도</th>
            <th>문헌</th>
            <th>유형</th>
            <th>읽은 범위</th>
            <th>카드</th>
          </tr>
        </thead>
        <tbody>
          {papers.map((p) => (
            <Fragment key={p.workId}>
              <tr className={open === p.workId ? "open" : ""} onClick={() => setOpen(open === p.workId ? null : p.workId)}>
                <td>{p.year ?? "—"}</td>
                <td>
                  <div className="genealogy-paper-title">{p.title}</div>
                  <small>
                    {p.authors.join(", ")}
                    {p.authors.length >= 3 ? " 외" : ""} · @{p.key}
                    {p.origin !== "collection" ? ` · ${ORIGINS[p.origin]}` : ""}
                  </small>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select aria-label="문헌 유형" value={p.type ?? ""} title={p.typeReason} onChange={(e) => onType(p.workId, e.target.value as PaperType)}>
                    {!p.type && <option value="">미정</option>}
                    {(Object.keys(PAPER_TYPES) as PaperType[]).map((t) => (
                      <option key={t} value={t}>
                        {t} · {PAPER_TYPES[t]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {p.basis === "none" && !p.textNote ? <span className="subtle">준비 전</span> : <span className={`badge${p.basis === "abstract" || p.basis === "none" ? " warning" : ""}`}>{TEXT_BASIS[p.basis]}</span>}
                </td>
                <td>
                  {p.cardStatus === "done" ? <Check size={14} className="green" /> : p.cardStatus === "failed" ? <TriangleAlert size={14} className="danger" /> : p.cardStatus === "stale" ? <span className="badge">다시 만들기</span> : <span className="subtle">—</span>}
                </td>
              </tr>
              {open === p.workId && (
                <tr className="genealogy-detail">
                  <td />
                  <td colSpan={4}>
                    <p>
                      <strong>유형 근거</strong> {p.typeReason || "—"}
                      {p.typeSource ? ` (${{ metadata: "서지 정보", ai: "AI 판정", user: "사용자 지정" }[p.typeSource]})` : ""}
                    </p>
                    <p>
                      <strong>읽은 범위</strong> {p.textNote || "자료 준비 전"}
                      {p.textSize ? ` · ${p.textSize.toLocaleString()}자` : ""}
                    </p>
                    {p.reason && (
                      <p>
                        <strong>추가 이유</strong> {p.reason}
                      </p>
                    )}
                    {p.cardError && <p className="danger">{p.cardError}</p>}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function GenealogyWorkspace({ id, onError, onDeleted }: { id: string; onError: (error: unknown) => void; onDeleted: () => void }) {
  const [view, setView] = useState<GenealogyView | null>(null);
  const [tab, setTab] = useState<Tab>("papers");
  const [draft, setDraft] = useState<GenealogySettings | null>(null);
  const load = useCallback(() => window.bunny.genealogyView({ id }).then(setView).catch(onError), [id, onError]);
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.bunny.onEvent((event) => {
      if (event.type !== "genealogy" || event.id !== id) return;
      // Progress arrives often; one refresh per quarter second is enough.
      timer ??= setTimeout(() => {
        timer = undefined;
        void load();
      }, 250);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [id, load]);
  useEffect(() => setDraft(null), [id]);
  if (!view) return <div className="genealogy loading"><LoaderCircle size={18} className="spin" /></div>;
  const g = view.genealogy;
  const running = g.job?.status === "running";
  const run = (step: GenealogyStep | "continue", auto = true) => window.bunny.genealogyStart({ id, step, auto }).then(() => load()).catch(onError);
  const included = view.papers.filter((p) => p.included).length;
  return (
    <div className="genealogy">
      <div className="workspace-heading">
        <div>
          <div className="eyebrow">GENEALOGY · {view.collectionName}</div>
          <h1>
            {g.title}
            <span>{included.toLocaleString()}</span>
          </h1>
          <p className="subtle genealogy-question">{g.settings.question || "연구 질문을 설정에서 적어 주세요."}</p>
        </div>
        <div className="workspace-actions">
          <button onClick={() => void window.bunny.genealogyReveal({ id }).catch(onError)}>
            <FolderOpen size={15} />
            작업 폴더
          </button>
          {running ? (
            <button onClick={() => void window.bunny.genealogyCancel({ id }).catch(onError)}>
              <Square size={14} />
              멈추기
            </button>
          ) : (
            <button className="primary" onClick={() => void run("continue")}>
              <Play size={15} />
              {Object.keys(g.completed).length ? "이어서 진행" : "시작"}
            </button>
          )}
        </div>
      </div>
      <Steps view={view} busy={running} onRun={(step) => void run(step, false)} />
      {g.job && (
        <div className={`genealogy-job ${g.job.status}`} role="status">
          {g.job.status === "running" ? <LoaderCircle size={14} className="spin" /> : g.job.status === "paused" ? <Pause size={14} /> : g.job.status === "failed" ? <TriangleAlert size={14} /> : <Check size={14} />}
          <strong>
            {STEP_NAMES[g.job.step]} · {STATUS_NAMES[g.job.status]}
          </strong>
          <span>{g.job.message}</span>
          {g.job.total > 0 && (
            <span className="genealogy-progress" aria-label="진행률">
              <span style={{ width: `${Math.min(100, (g.job.done / g.job.total) * 100)}%` }} />
            </span>
          )}
          {g.job.calls > 0 && <small>AI {g.job.calls}회</small>}
        </div>
      )}
      <div className="genealogy-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="genealogy-body">
        {tab === "papers" && <Papers view={view} onType={(workId, type) => void window.bunny.genealogyType({ id, workId, type }).then(() => load()).catch(onError)} />}
        {tab === "settings" && (
          <>
            <GenealogySettingsForm value={draft ?? g.settings} onChange={setDraft} />
            <p className="subtle">작업 폴더: {g.workspace}</p>
            <div className="inline-actions">
              <button
                className="primary"
                disabled={!draft || running}
                onClick={() =>
                  void window.bunny
                    .genealogyUpdate({ id, settings: draft! })
                    .then(() => {
                      setDraft(null);
                      return load();
                    })
                    .catch(onError)
                }
              >
                설정 저장
              </button>
              <button
                className="danger"
                disabled={running}
                onClick={() => {
                  if (confirm(`‘${g.title}’ 계보 리포트를 앱에서 지울까요? 작업 폴더의 파일과 컬렉션은 그대로 둡니다.`))
                    void window.bunny.genealogyDelete({ id }).then(onDeleted).catch(onError);
                }}
              >
                <Trash2 size={14} />
                리포트 지우기
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
