import { useEffect, useState } from "react";
import type { Input } from "../../shared/contracts";
import type { PdfDownloadPreview, Run } from "../../shared/types";
import { Modal } from "./Modal";
import { DownloadResults } from "./DownloadResults";

export function DownloadDialog({ projectId, selected, scope, scopeId, runs, busy, initialRunId, onClose, onError }: {
  projectId: string;
  selected: string[];
  scope: string;
  scopeId: string;
  runs: Run[];
  busy: boolean;
  initialRunId?: string;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const category = ["topic", "unclassified", "collection"].includes(scope);
  const [targetScope, setTargetScope] = useState<Input<"downloadPdfs">["scope"]>(selected.length ? "selected" : category ? scope as Input<"downloadPdfs">["scope"] : "archive");
  const [includeBooks, setIncludeBooks] = useState(false);
  const [useBrowser, setUseBrowser] = useState(true);
  const [downloadDirectory, setDownloadDirectory] = useState("");
  const [preview, setPreview] = useState<PdfDownloadPreview | null>(null);
  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState(initialRunId || "");
  const [started, setStarted] = useState<Run | null>(null);
  const downloads = runs.filter(r => r.download);
  const run = downloads.find(r => r.id === runId) || started;
  useEffect(() => {
    let valid = true;
    setPreview(null);
    if (busy) return;
    void window.bunny.pdfDownloadPreview({ projectId, scope: targetScope, scopeId: scopeId || undefined, ids: selected, includeBooks })
      .then(result => { if (valid) setPreview(result); })
      .catch(error => { if (valid) onError(error); });
    return () => { valid = false; };
  }, [projectId, targetScope, scopeId, selected, includeBooks, busy, onError]);
  const start = async () => {
    setStarting(true);
    try {
      const result = await window.bunny.downloadPdfs({ projectId, scope: targetScope, scopeId: scopeId || undefined, ids: selected, includeBooks, useBrowser, downloadDirectory: downloadDirectory || undefined });
      setStarted(result); setRunId(result.id);
    } catch (error) { onError(error); } finally { setStarting(false); }
  };
  return <Modal title="PDF 원문 찾기" wide onClose={onClose}>
    <p className="subtle">원문을 확보해 기존 논문에 첨부합니다. 분류·노트·읽기 상태를 유지하며, 이미 보관한 PDF는 건너뜁니다.</p>
    <div className="download-options">
      <label>대상 범위
        <select aria-label="원문 확보 대상" value={targetScope} onChange={e => setTargetScope(e.target.value as typeof targetScope)}>
          <option value="archive">전체 아카이브</option>
          <option value="selected" disabled={!selected.length}>선택한 문헌 · {selected.length}편</option>
          {category && <option value={scope}>{scope === "topic" ? "현재 분류" : scope === "unclassified" ? "미분류 문헌" : "현재 컬렉션"}</option>}
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={includeBooks} onChange={e => setIncludeBooks(e.target.checked)} />책·챕터도 시도</label>
      <label className="check"><input type="checkbox" checked={useBrowser} disabled={busy || starting} onChange={e => setUseBrowser(e.target.checked)} />로그인된 Chrome 사용</label>
    </div>
    {useBrowser && <div className="inline-actions"><span className="subtle">Chrome 다운로드 폴더 · {downloadDirectory || "자동 감지"}</span><button disabled={busy || starting} onClick={() => void window.bunny.chooseDownloadDirectory({}).then(path => { if (path) setDownloadDirectory(path); }).catch(onError)}>폴더 선택</button></div>}
    <p className="subtle">범위에는 화면의 검색·필터를 적용하지 않습니다. 선택 범위는 숨겨진 선택도 포함합니다.</p>
    <p role="status">{preview ? `대상 ${preview.total}편 · 기존 PDF ${preview.existing}편 · 책·챕터 제외 ${preview.books}편 · 확보 시도 ${preview.eligible}편` : busy ? "진행 중인 작업이 끝난 뒤 새 작업을 시작할 수 있습니다." : "대상 확인 중…"}</p>
    <p className="subtle">{useBrowser ? "현재 Chrome 창의 로그인 상태로 원문을 열고 PDF를 내려받습니다. 처음 실행할 때 Chrome 제어 권한이 필요하며, Apple Events의 JavaScript 허용은 Chrome에서 직접 켜야 합니다. 로그인·사람 인증은 Chrome에서 완료하세요. 논문별 최대 60초 후 공개 원문 보조 경로를 확인합니다." : "공개 원문과 출판사 PDF 주소를 확인합니다. 로그인·사람 인증이 필요한 자료는 원문 페이지에서 직접 내려받으세요."} 창을 닫아도 작업은 계속됩니다.</p>
    <button className="primary" disabled={busy || starting || !preview?.eligible} onClick={() => void start()}>{starting ? "시작 중…" : "원문 확보 시작"}</button>
    {!!downloads.length && <label className="download-history">작업 기록
      <select aria-label="원문 확보 작업 기록" value={runId} onChange={e => { setStarted(null); setRunId(e.target.value); }}>
        <option value="">기록 선택</option>
        {downloads.map(r => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString("ko-KR")} · {r.query}</option>)}
      </select>
    </label>}
    {run && <DownloadResults run={run} busy={busy || starting} onError={onError} onResume={() => window.bunny.controlRun({ runId: run.id, action: "resume", useBrowser, downloadDirectory: downloadDirectory || undefined })} />}
  </Modal>;
}
