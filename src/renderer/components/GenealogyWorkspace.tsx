import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, FileText, FolderOpen, LoaderCircle, Pause, Play, RotateCcw, Save, Square, Trash2, TriangleAlert, Undo2, X } from "lucide-react";
import {
  BRANCH_STATUS,
  ORIGINS,
  PAPER_TYPES,
  STEPS,
  STEP_NAMES,
  TEXT_BASIS,
  type GenealogyCard,
  type GenealogySettings,
  type GenealogyStep,
  type GenealogyView,
  type PaperType,
} from "../../shared/genealogy";
import { GenealogySettingsForm } from "./GenealogySettingsForm";

type Tab = "papers" | "candidates" | "outline" | "settings";
const TABS: { key: Tab; label: string }[] = [
  { key: "papers", label: "문헌" },
  { key: "candidates", label: "추가" },
  { key: "outline", label: "목차" },
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

const ROLE_NAMES = { origin: "출발점", support: "지지", refute: "반박", method: "방법", review: "정리" } as const;

function CardView({ card }: { card: GenealogyCard }) {
  const list = (label: string, items: string[]) =>
    items.length > 0 && (
      <div className="genealogy-card-field">
        <strong>{label}</strong>
        <ul>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </div>
    );
  const field = (label: string, text: string) =>
    text && (
      <div className="genealogy-card-field">
        <strong>{label}</strong>
        <p>{text}</p>
      </div>
    );
  return (
    <div className="genealogy-card">
      {field("계보상 의의", card.significance)}
      {field("계보 위치", card.position)}
      {field("문제제기", card.problem)}
      {list("가설·주장·정의", card.claims)}
      {card.evidence.length > 0 && (
        <div className="genealogy-card-field">
          <strong>근거</strong>
          <ul>
            {card.evidence.map((e, i) => (
              <li key={i}>
                {e.text}
                <blockquote>{e.quote}</blockquote>
              </li>
            ))}
          </ul>
        </div>
      )}
      {field("해석·방법론 비판", card.critique)}
      {list("미해결", card.unresolved)}
      {field("자금·이해상충·학파", card.interests)}
      {list("앞선 연구", card.foundations.map((f) => `${f.mention} (${ROLE_NAMES[f.role]}) — ${f.claim}`))}
      {list("가지 상태 신호", card.statusSignals)}
      {list("⚠ 주의", card.cautions)}
    </div>
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
        {papers.length}편 · 카드 {papers.filter((p) => p.cardStatus === "done").length}편 · {Object.entries(counts).map(([k, n]) => `${TEXT_BASIS[k as keyof typeof TEXT_BASIS]} ${n}`).join(" · ")}. 유형을 바꾸면 그 논문의 카드를 다시 만듭니다.
      </p>
      <table className="genealogy-table papers">
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
                    {view.cards[p.workId] ? <CardView card={view.cards[p.workId]} /> : <p className="subtle">카드가 아직 없습니다.</p>}
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

function Candidates({ view, busy, onDecide, onUndo }: { view: GenealogyView; busy: boolean; onDecide: (id: string, action: "accept" | "reject" | "reset") => void; onUndo: (workId: string) => void }) {
  const added = view.papers.filter((p) => p.included && p.origin !== "collection");
  const pending = view.candidates.filter((c) => c.decision === "pending" && c.score > 0);
  const rejected = view.candidates.filter((c) => c.decision === "rejected");
  const mode = { auto: "자동 채택", suggest: "제안만", off: "끄기" }[view.genealogy.settings.expansion];
  return (
    <>
      <p className="subtle">
        공백 점검이 찾은, 계보 문헌이 기대거나(공통 참고문헌·카드 속 언급) 이어받는(최근 후속 연구) 논문입니다. 반영 방식: {mode}. 채택하면 아카이브 → 서고 → OpenAlex 순으로 찾아 컬렉션에 넣고, 다음 진행에서 자료 준비와 카드를 만듭니다.
      </p>
      {added.length > 0 && (
        <>
          <h3 className="genealogy-subhead">리포트가 추가한 문헌 {added.length}</h3>
          <ul className="genealogy-list">
            {added.map((p) => (
              <li key={p.workId}>
                <div>
                  <div className="genealogy-paper-title">{p.title}</div>
                  <small>
                    {p.year ?? "—"} · {ORIGINS[p.origin]}
                    {p.round ? ` · ${p.round}차` : ""} · {p.reason}
                  </small>
                </div>
                <button disabled={busy} onClick={() => onUndo(p.workId)} title="컬렉션에서 빼고, 리포트가 아카이브에 처음 넣었다면 아카이브에서도 뺍니다.">
                  <Undo2 size={14} />
                  되돌리기
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="genealogy-subhead">후보 {pending.length}</h3>
      {!pending.length && <p className="subtle">{view.genealogy.completed.gaps ? "남은 후보가 없습니다." : "공백 점검을 실행하면 후보가 나옵니다."}</p>}
      <ul className="genealogy-list">
        {pending.map((c) => (
          <li key={c.id}>
            <div>
              <div className="genealogy-paper-title">
                {c.title} {c.role && <span className="badge">{c.role}</span>}
              </div>
              <small>
                {c.year ?? "—"} · {c.authors.join(", ")}
                {c.venue ? ` · ${c.venue}` : ""}
              </small>
              <small className="block">
                {[c.cocited.length && `공통 참고문헌 ${c.cocited.length}편`, c.mentions.length && `카드 언급 ${c.mentions.length}회 (${c.mentions.slice(0, 2).map((m) => m.text).join("; ")})`, c.cites.length && `계보 문헌 ${c.cites.length}편을 인용`, c.requests.length && `집필 요청 ${c.requests.length}건`].filter(Boolean).join(" · ")}
                {` · 점수 ${c.score.toFixed(2)}`}
              </small>
              {c.reason && <p className="genealogy-reason">{c.reason}</p>}
            </div>
            <div className="inline-actions">
              <button className="primary" disabled={busy} onClick={() => onDecide(c.id, "accept")}>
                <Check size={14} />
                채택
              </button>
              <button disabled={busy} onClick={() => onDecide(c.id, "reject")}>
                <X size={14} />
                제외
              </button>
            </div>
          </li>
        ))}
      </ul>
      {rejected.length > 0 && (
        <details>
          <summary className="subtle">제외한 후보 {rejected.length}</summary>
          <ul className="genealogy-list">
            {rejected.map((c) => (
              <li key={c.id}>
                <div>
                  <div className="genealogy-paper-title">{c.title}</div>
                  <small>{c.year ?? "—"}</small>
                </div>
                <button disabled={busy} onClick={() => onDecide(c.id, "reset")}>
                  <RotateCcw size={14} />
                  되살리기
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function OutlineTab({ view, busy, onSave, onSync, onApprove }: { view: GenealogyView; busy: boolean; onSave: (markdown: string) => void; onSync: () => void; onApprove: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const outline = view.outline;
  const titles = new Map(view.papers.map((p) => [p.key, `${p.authors[0] ?? ""} ${p.year ?? ""}`.trim() || p.key]));
  if (!outline) return <p className="subtle">가지 장부·목차 단계를 실행하면 상세 목차가 여기에 나옵니다.</p>;
  if (draft !== null)
    return (
      <div className="genealogy-editor">
        <p className="subtle">장(##)·절(###) 제목, 논지, 질문, 증거를 고칠 수 있습니다. rb:section 주석의 keys는 그 절이 기대는 문헌입니다. 저장하면 바뀐 절만 다시 씁니다.</p>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
        <div className="inline-actions">
          <button className="primary" disabled={busy} onClick={() => { onSave(draft); setDraft(null); }}>
            <Save size={14} />
            목차 저장
          </button>
          <button onClick={() => setDraft(null)}>취소</button>
        </div>
      </div>
    );
  return (
    <div className="genealogy-outline">
      <div className="inline-actions">
        <button disabled={busy || !view.contents} onClick={() => setDraft(view.contents ?? "")}>
          <FileText size={14} />
          목차 고치기
        </button>
        {view.contentsEdited && (
          <button disabled={busy} onClick={onSync} title="다른 편집기에서 고친 00_contents.md를 읽어 옵니다.">
            <RotateCcw size={14} />
            고친 파일 읽기
          </button>
        )}
        {view.genealogy.outlineApproved ? (
          <span className="badge">승인됨</span>
        ) : (
          <button className="primary" disabled={busy} onClick={onApprove}>
            <Check size={14} />
            목차 승인
          </button>
        )}
      </div>
      {view.contentsEdited && <p className="notice">작업 폴더의 00_contents.md가 앱이 쓴 뒤 바뀌었습니다. ‘고친 파일 읽기’를 누르면 그 내용으로 목차를 바꿉니다.</p>}
      <h2>{outline.title}</h2>
      {outline.subtitle && <p className="subtle">{outline.subtitle}</p>}
      {outline.summary && <p className="genealogy-summary">{outline.summary}</p>}
      {view.branches.length > 0 && (
        <details className="genealogy-ledger" open>
          <summary>가지 장부 · {view.branches.length}개</summary>
          <table className="genealogy-table ledger">
            <thead>
              <tr>
                <th>가지</th>
                <th>상태</th>
                <th>근거</th>
              </tr>
            </thead>
            <tbody>
              {view.branches.map((b) => (
                <tr key={b.id}>
                  <td>
                    <strong>{b.name}</strong>
                    <small className="block">{b.claim}</small>
                    <small className="block">출발: {b.origin.map((k) => titles.get(k) ?? k).join(", ") || "—"}{b.lastActive ? ` · 마지막 활동 ${b.lastActive}` : ""}</small>
                  </td>
                  <td>
                    <span className={`badge branch-${b.status}`}>{BRANCH_STATUS[b.status]}</span>
                  </td>
                  <td>
                    <small>{b.evidence}</small>
                    {b.reason && <small className="block">{b.status === "blocked" ? "막힌 이유: " : ""}{b.reason}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <ol className="genealogy-chapters">
        {outline.chapters.map((c) => (
          <li key={c.number}>
            <h3>
              {c.number}. {c.title}
            </h3>
            {c.thesis && <p className="genealogy-thesis">{c.thesis}</p>}
            <ol>
              {c.sections.map((s) => (
                <li key={s.id}>
                  <strong>
                    {s.id} {s.title}
                  </strong>
                  {s.status !== "planned" && <span className="badge">{{ written: "집필됨", stale: "다시 쓸 차례", edited: "직접 고침", planned: "" }[s.status]}</span>}
                  {s.thesis && <p>{s.thesis}</p>}
                  {s.questions.length > 0 && <small className="block">질문: {s.questions.join(" / ")}</small>}
                  {s.evidence && <small className="block">가를 증거: {s.evidence}</small>}
                  {s.keys.length > 0 && <small className="block">문헌: {s.keys.map((k) => titles.get(k) ?? k).join(", ")}</small>}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </div>
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
        {tab === "candidates" && (
          <Candidates
            view={view}
            busy={running}
            onDecide={(candidateId, action) => void window.bunny.genealogyCandidate({ id, candidateId, action }).then(() => load()).catch(onError)}
            onUndo={(workId) => void window.bunny.genealogyRemovePaper({ id, workId }).then(() => load()).catch(onError)}
          />
        )}
        {tab === "outline" && (
          <OutlineTab
            view={view}
            busy={running}
            onSave={(markdown) => void window.bunny.genealogyOutlineSave({ id, markdown }).then(() => load()).catch(onError)}
            onSync={() => void window.bunny.genealogyOutlineSave({ id }).then(() => load()).catch(onError)}
            onApprove={() => void window.bunny.genealogyApprove({ id }).then(() => load()).catch(onError)}
          />
        )}
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
