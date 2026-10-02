import { useEffect, useMemo, useState } from "react";
import type { Input } from "../../shared/contracts";
import type { MissingPdfs, Run } from "../../shared/types";
import { Modal } from "./Modal";
import { ImportResults } from "./ImportResults";
import { MissingPdfList } from "./MissingPdfList";

export function DownloadDialog({ projectId, selected, scope, scopeId, runs, busy, onClose, onError }: {
  projectId: string;
  selected: string[];
  scope: string;
  scopeId: string;
  runs: Run[];
  busy: boolean;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const category = ["topic", "unclassified", "collection"].includes(scope);
  const [targetScope, setTargetScope] = useState<Input<"downloadPdfs">["scope"]>(selected.length ? "selected" : category ? scope as Input<"downloadPdfs">["scope"] : "archive");
  const [includeBooks, setIncludeBooks] = useState(false);
  const [useBrowser, setUseBrowser] = useState(true);
  const [downloadDirectory, setDownloadDirectory] = useState("");
  const [queue, setQueue] = useState<{ target: string; data: MissingPdfs } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<Run | null>(null);
  const [matching, setMatching] = useState(false);
  const [matched, setMatched] = useState<Run | null>(null);
  const target = useMemo(() => ({ projectId, scope: targetScope, scopeId: scopeId || undefined, ids: selected, includeBooks }), [projectId, targetScope, scopeId, selected, includeBooks]);
  const targetKey = JSON.stringify(target);
  const remaining = queue?.target === targetKey ? queue.data : null;
  const pdfRevision = runs.filter(r => r.import || r.download).map(r => `${r.id}:${r.updatedAt}`).join("|");
  const activeRun = runs.find(r => r.download && ["running", "queued"].includes(r.status));
  const run = activeRun || runs.find(r => r.id === started?.id) || started;
  const matchRun = runs.find(r => r.id === matched?.id) || matched || runs.find(r => r.import?.matchExistingOnly);
  const downloading = !!run && ["running", "queued"].includes(run.status);
  const pending = starting || matching;

  useEffect(() => {
    let valid = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const data = await window.bunny.missingPdfs(target);
        if (!valid) return;
        setQueue({ target: targetKey, data });
        if (data.downloadDirectory) setDownloadDirectory(current => current || data.downloadDirectory!);
        timer = setTimeout(() => void load(), 3000);
      } catch (error) { if (valid) onError(error); }
    };
    void load();
    return () => { valid = false; clearTimeout(timer); };
  }, [target, targetKey, pdfRevision, busy, refresh, onError]);

  const start = async () => {
    if (!remaining?.items.length) return;
    setStarting(true);
    try {
      // Retry the current unresolved set, rather than a historical run's inputs.
      const result = await window.bunny.downloadPdfs({ projectId, scope: "selected", ids: remaining.items.slice(0, 1000).map(item => item.workId), includeBooks, useBrowser, downloadDirectory: downloadDirectory || undefined });
      setStarted(result);
      setRefresh(value => value + 1);
    } catch (error) { onError(error); } finally { setStarting(false); }
  };
  const matchFolder = async () => {
    setMatching(true);
    try {
      const result = await window.bunny.choosePdfMatch({ projectId });
      if (result) setMatched(result);
      setRefresh(value => value + 1);
    } catch (error) { onError(error); } finally { setMatching(false); }
  };
  const attempted = runs.some(r => r.download);
  const items = run?.download?.items || [];
  return <Modal title="PDF 원문 찾기" wide onClose={onClose}>
    <p className="subtle">남은 문헌의 원문을 찾아 연결하세요. PDF가 연결되면 아래 목록에서 자동으로 빠집니다.</p>
    <label className="download-scope">대상 범위
      <select aria-label="원문 확보 대상" value={targetScope} onChange={e => setTargetScope(e.target.value as typeof targetScope)}>
        <option value="archive">전체 아카이브</option>
        <option value="selected" disabled={!selected.length}>선택한 문헌 · {selected.length}편</option>
        {category && <option value={scope}>{scope === "topic" ? "현재 분류" : scope === "unclassified" ? "미분류 문헌" : "현재 컬렉션"}</option>}
      </select>
    </label>
    <p role="status" aria-live="polite" className="pdf-current-summary">{remaining ? `대상 ${remaining.total}편 · PDF 연결 ${remaining.existing}편 · 남은 문헌 ${remaining.eligible}편${remaining.books ? ` · 책·챕터 제외 ${remaining.books}편` : ""}` : "현재 PDF 연결 상태 확인 중…"}</p>
    <div className="inline-actions">
      <button className="primary" disabled={busy || pending || downloading || !remaining?.eligible} onClick={() => void start()}>{starting ? "시작 중…" : attempted ? `남은 ${Math.min(remaining?.eligible || 0, 1000)}편 자동 재시도` : "원문 찾기 시작"}</button>
      <button disabled={busy || pending || downloading} onClick={() => void matchFolder()}>{matching ? "폴더 확인 중…" : "다운로드한 PDF 폴더 연결"}</button>
      <button disabled={pending} onClick={() => setRefresh(value => value + 1)}>연결 상태 새로고침</button>
    </div>
    <p className="subtle">DOI·원문 페이지에서 내려받은 PDF는 폴더 연결 또는 PDF 직접 연결로 첨부하세요. 페이지를 여는 것만으로는 확보 완료로 처리하지 않습니다.</p>
    {downloading && run && <section className="download-progress">
      <p role="status">{run.message}</p>
      <progress aria-label="원문 확보 진행" max={items.length || 1} value={items.filter(item => !["pending", "running"].includes(item.status)).length} />
      <div className="inline-actions">
        <button onClick={() => void window.bunny.controlRun({ runId: run.id, action: "skip" }).catch(onError)}>현재 문헌 건너뛰기</button>
        <button onClick={() => void window.bunny.controlRun({ runId: run.id, action: "cancel" }).catch(onError)}>작업 취소</button>
      </div>
    </section>}
    {matchRun && <section className="pdf-folder-match">
      <p role="status">폴더 연결 · {matchRun.message}</p>
      {["running", "queued"].includes(matchRun.status) && <>
        <progress aria-label="PDF 폴더 연결 진행" max={matchRun.total || 1} value={matchRun.import?.index || 0} />
        <button onClick={() => void window.bunny.controlRun({ runId: matchRun.id, action: "cancel" }).catch(onError)}>폴더 연결 취소</button>
      </>}
      <details key={matchRun.id}>
        <summary>폴더 연결 파일별 결과</summary>
        <ImportResults runId={matchRun.id} refreshKey={matchRun.updatedAt} autoShow busy={busy || pending} onError={onError} onResume={() => window.bunny.controlRun({ runId: matchRun.id, action: "resume" })} />
      </details>
      {["cancelled", "interrupted", "failed"].includes(matchRun.status) && <button disabled={busy || pending} onClick={() => void window.bunny.controlRun({ runId: matchRun.id, action: "resume" }).catch(onError)}>폴더 연결 재개</button>}
    </section>}
    <MissingPdfList projectId={projectId} items={remaining?.items || []} ready={!!remaining} busy={busy || pending || downloading} onError={onError} onConnected={() => setRefresh(value => value + 1)} />
    <details className="download-settings">
      <summary>자동 원문 찾기 설정</summary>
      <div className="download-options">
        <label className="check"><input type="checkbox" checked={includeBooks} onChange={e => setIncludeBooks(e.target.checked)} />책·챕터도 시도</label>
        <label className="check"><input type="checkbox" checked={useBrowser} disabled={busy || pending} onChange={e => setUseBrowser(e.target.checked)} />로그인된 Chrome 사용</label>
      </div>
      {useBrowser && <div className="inline-actions"><span className="subtle">Chrome 다운로드 폴더 · {downloadDirectory || "자동 감지"}</span><button disabled={busy || pending} onClick={() => void window.bunny.chooseDownloadDirectory({}).then(path => { if (path) setDownloadDirectory(path); }).catch(onError)}>폴더 선택</button></div>}
      <p className="subtle">폴더와 하위 폴더에서 DOI·제목이 일치하는 본문 PDF만 기존 문헌에 연결합니다. 분류·노트·읽기 상태와 원본 파일을 유지합니다. 범위에는 화면의 검색·필터를 적용하지 않으며 숨겨진 선택도 포함합니다.</p>
      <p className="subtle">{useBrowser ? "현재 Chrome 창의 로그인 상태로 원문을 열고 PDF를 내려받습니다. Chrome 제어 권한과 Chrome의 Apple Events JavaScript 허용이 필요합니다. 로그인·사람 인증은 Chrome에서 완료하세요. 논문별 최대 60초 후 공개 원문 보조 경로를 확인합니다." : "공개 원문과 출판사 PDF 주소를 확인합니다. 로그인·사람 인증이 필요한 자료는 원문 페이지에서 직접 내려받으세요."} 창을 닫아도 작업은 계속됩니다.</p>
      {remaining && remaining.eligible > 1000 && <p className="subtle">한 번에 최대 1,000편을 시도합니다. 완료 후 남은 문헌을 다시 시도할 수 있습니다.</p>}
    </details>
  </Modal>;
}
