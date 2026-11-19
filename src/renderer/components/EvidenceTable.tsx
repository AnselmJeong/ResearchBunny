import { useCallback, useEffect, useState } from "react";
import { BookOpenText, Download, LoaderCircle, Plus, RotateCcw, Square, Table2, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import {
  CELL_STATUS,
  DEFAULT_COLUMNS,
  type EvidenceCell,
  type EvidenceColumn,
  type EvidenceTableView,
} from "../../shared/evidence";
import type { Input } from "../../shared/contracts";
import { PURPOSE_NAMES, type ScreeningPurpose } from "../../shared/screening";

type Target = Input<"evidenceTable">["target"];
let draftId = 0;
const newId = () => `c${Date.now().toString(36)}${draftId++}`;

function Cell({ cell, onOpen }: { cell: EvidenceCell | undefined; onOpen: (cell: EvidenceCell) => void }) {
  if (!cell) return <td className="evidence-cell missing">—</td>;
  if (!cell.value)
    return (
      <td className={`evidence-cell ${cell.status}`} title={cell.rejected ? `버린 값: ${cell.rejected}` : undefined}>
        <span className="subtle">{CELL_STATUS[cell.status]}</span>
      </td>
    );
  return (
    <td className="evidence-cell">
      <div>{cell.value}</div>
      <details>
        <summary>{cell.page ? `p. ${cell.page}${cell.pageEnd && cell.pageEnd !== cell.page ? `–${cell.pageEnd}` : ""}` : "초록"}</summary>
        <blockquote>{cell.quote}</blockquote>
        {cell.page && (
          <button className="text-button" onClick={() => onOpen(cell)}><BookOpenText size={12} /> 원문 열기</button>
        )}
      </details>
    </td>
  );
}

/** A project's evidence table for its archive or a collection: one row per paper, cells checked against the text. */
export function EvidenceTable({ projectId, target, title, purpose, onClose, onOpen, onError }: {
  projectId: string;
  target: Target;
  title: string;
  purpose: ScreeningPurpose;
  onClose: () => void;
  onOpen: (workId: string, attachmentId: string | undefined, page: number) => void;
  onError: (error: unknown) => void;
}) {
  const [view, setView] = useState<EvidenceTableView | null>(null);
  const [editing, setEditing] = useState<EvidenceColumn[] | null>(null);
  const [busy, setBusy] = useState(false);
  // The target arrives as a new object on every render; its contents decide when to load again.
  const targetKey = JSON.stringify(target);
  const load = useCallback(
    () => window.bunny.evidenceTable({ projectId, target: JSON.parse(targetKey) as Target }).then(setView).catch(onError),
    [projectId, targetKey, onError],
  );
  useEffect(() => {
    void load();
    return window.bunny.onEvent((event) => {
      if (event.type === "progress" || event.type === "changed") void load();
    });
  }, [load]);
  const running = view?.job?.status === "running";
  const fill = (fresh: boolean) => {
    setBusy(true);
    void window.bunny.evidenceFill({ projectId, target, fresh }).then(() => load()).catch(onError).finally(() => setBusy(false));
  };
  const save = () => {
    if (!editing) return;
    setBusy(true);
    void window.bunny.evidenceColumns({ projectId, columns: editing })
      .then(() => { setEditing(null); return load(); })
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const exportAs = (format: "csv" | "md") => void window.bunny.exportEvidence({ projectId, target, format }).catch(onError);
  const columns = view?.config.columns ?? [];
  return (
    <Modal title={`근거 표 · ${title}`} onClose={onClose} wide>
      <div className="evidence-table-dialog">
        <p className="subtle">
          논문마다 열에 해당하는 본문 구절을 찾아 AI가 칸을 채웁니다. 칸마다 원문 인용과 쪽을 남기고, 인용이 구절에 없거나 값의 숫자가 인용에 없으면 칸을 비웁니다.
          서고에 색인된 PDF가 없는 논문은 초록으로 채우고 ‘초록 기반’으로 표시하며, 원문이 생기면 다시 채웁니다. 표는 프로젝트마다 따로입니다.
        </p>
        <div className="inline-actions">
          {running ? (
            <>
              <span className="subtle" role="status"><LoaderCircle size={13} className="spin" /> {view?.job?.message}</span>
              <button className="secondary" onClick={() => void window.bunny.evidenceCancel({ projectId }).catch(onError)}><Square size={13} /> 취소</button>
            </>
          ) : (
            <>
              <button className="primary" disabled={busy || !view} onClick={() => fill(false)}>
                <Table2 size={14} /> {view?.missing.length ? `빈 행 채우기 (${view.missing.length}편)` : "새로 채울 행 채우기"}
              </button>
              <button className="secondary" disabled={busy || !view?.rows.length} onClick={() => fill(true)}><RotateCcw size={13} /> 전부 다시</button>
              {view?.job && <span className={view.job.status === "failed" ? "warning-text" : "subtle"}>{view.job.message}</span>}
            </>
          )}
          <span className="filter-end">
            <button className="secondary" disabled={!view?.rows.length} onClick={() => exportAs("csv")}><Download size={13} /> CSV</button>
            <button className="secondary" disabled={!view?.rows.length} onClick={() => exportAs("md")}><Download size={13} /> Markdown</button>
            <button className="secondary" disabled={running} onClick={() => setEditing(editing ? null : columns.map((c) => ({ ...c })))}>열 편집</button>
          </span>
        </div>
        {editing && (
          <fieldset className="criterion-list">
            <legend>열: 이름과 ‘무엇을 찾는가’ 한 줄. 열을 바꾸면 채운 행은 ‘열 변경 전’으로 표시됩니다.</legend>
            {editing.map((c, index) => (
              <div className="criterion-row" key={c.id}>
                <span className="criterion-number">{index + 1}</span>
                <input aria-label={`열 ${index + 1} 이름`} className="column-name" value={c.name} maxLength={40} placeholder="예: 용량"
                  onChange={(e) => setEditing(editing.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))} />
                <input aria-label={`열 ${index + 1} 찾을 것`} value={c.seek} maxLength={300} placeholder="예: 투여한 약의 용량과 기간"
                  onChange={(e) => setEditing(editing.map((x) => (x.id === c.id ? { ...x, seek: e.target.value, query: x.query && x.seek !== x.query ? x.query : e.target.value } : x)))} />
                <button type="button" className="icon-button" aria-label={`열 ${index + 1} 빼기`} onClick={() => setEditing(editing.filter((x) => x.id !== c.id))}><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="inline-actions">
              <button type="button" className="text-button" disabled={editing.length >= 16} onClick={() => setEditing([...editing, { id: newId(), name: "", seek: "", query: "" }])}><Plus size={13} /> 열 추가</button>
              <button type="button" className="text-button" onClick={() => setEditing(DEFAULT_COLUMNS[purpose].map((c) => ({ ...c })))}>{PURPOSE_NAMES[purpose]} 기본 열로</button>
              <span className="filter-end">
                <button onClick={() => setEditing(null)}>취소</button>
                <button className="primary" disabled={busy || !editing.some((c) => c.name.trim())} onClick={save}>열 저장</button>
              </span>
            </div>
          </fieldset>
        )}
        {!view ? (
          <p className="subtle"><LoaderCircle size={13} className="spin" /> 불러오는 중…</p>
        ) : (
          <div className="evidence-scroll">
            <table className="evidence-table">
              <thead>
                <tr>
                  <th>논문</th>
                  {columns.map((c) => <th key={c.id} title={c.seek}>{c.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.workId}>
                    <th scope="row">
                      <div className="evidence-paper">{row.authors[0]?.split(",")[0] || "저자 미상"}{row.authors.length > 1 ? " 외" : ""} {row.year ?? ""}</div>
                      <div className="subtle evidence-title">{row.title}</div>
                      {row.basis === "abstract" && <span className="badge">초록 기반</span>}
                      {row.stale && <span className="badge">열 변경 전</span>}
                      {row.error && <div className="warning-text">{row.error}</div>}
                    </th>
                    {columns.map((c) => <Cell key={c.id} cell={row.cells[c.id]} onOpen={(cell) => { onClose(); onOpen(row.workId, cell.attachmentId ?? undefined, cell.page!); }} />)}
                  </tr>
                ))}
                {view.missing.map((m) => (
                  <tr key={m.workId} className="evidence-missing">
                    <th scope="row"><div className="subtle evidence-title">{m.title} {m.year ?? ""}</div></th>
                    <td colSpan={columns.length} className="subtle">아직 채우지 않음</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
