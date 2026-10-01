import type { Run } from "../../shared/types";
const statuses = { pending: "대기", running: "확보 중", completed: "확보 완료", existing: "기존 PDF", skipped: "제외", failed: "확보 실패" };
export function DownloadResults({ run, busy, onError, onResume }: {
  run: Run;
  busy: boolean;
  onError: (error: unknown) => void;
  onResume: () => Promise<unknown>;
}) {
  const items = run.download?.items || [];
  const active = ["running", "queued"].includes(run.status);
  const unfinished = items.some(i => ["pending", "running", "failed"].includes(i.status));
  const failedFirst = [...items].sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"));
  return <section className="download-results">
    <p role="status" aria-live="polite">{run.message}</p>
    <progress aria-label="원문 확보 진행" max={items.length || 1} value={items.filter(i => !["pending", "running"].includes(i.status)).length} />
    <div className="inline-actions">
      {active ? <button onClick={() => void window.bunny.controlRun({ runId: run.id, action: "cancel" }).catch(onError)}>작업 취소</button>
        : unfinished && <button disabled={busy} onClick={() => void onResume().catch(onError)}>미처리·실패 항목 재시도</button>}
    </div>
    <ul className="download-items">
      {failedFirst.slice(0, 100).map(item => <li key={item.workId}>
        <strong>{item.title}</strong>
        <p className="subtle">{statuses[item.status]} · {item.message}</p>
        {item.status === "failed" && <div className="inline-actions">
          <button onClick={() => void window.bunny.openExternal({ workId: item.workId, kind: "source" }).catch(onError)}>원문 페이지</button>
          <button onClick={() => void window.bunny.openExternal({ workId: item.workId, kind: "doi" }).catch(onError)}>DOI 페이지</button>
          <button disabled={busy || active} onClick={() => void window.bunny.choosePdf({ projectId: run.projectId, workId: item.workId, mode: "managed" }).catch(onError)}>PDF 직접 연결</button>
        </div>}
      </li>)}
    </ul>
    {items.length > 100 && <p className="subtle">최대 100편 표시 · 실패 항목부터 표시합니다.</p>}
  </section>;
}
