import { useEffect, useState } from "react";
import { FolderOpen, LibraryBig, LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { DEFAULT_EMBED_MODEL, DEFAULT_OLLAMA_URL, DEFAULT_SHELF_EXCLUDE, isLoopbackUrl, type ShelfStatusResult } from "../../shared/shelf";
import type { Input } from "../../shared/contracts";

const STATUS_LABELS: [keyof ShelfStatusResult["summary"]["counts"]["statuses"], string][] = [
  ["ok", "확인됨"], ["review", "확인 필요"], ["provisional", "파일명 서지"], ["auxiliary", "보충자료"], ["failed", "실패"], ["missing", "사라짐"],
];

export function ShelfSettings({ onError, onChanged }: { onError: (error: unknown) => void; onChanged: () => void }) {
  const [status, setStatus] = useState<ShelfStatusResult | null>(null);
  const [path, setPath] = useState("");
  const [exclude, setExclude] = useState(DEFAULT_SHELF_EXCLUDE.join(", "));
  const [model, setModel] = useState(DEFAULT_EMBED_MODEL);
  const [ollamaUrl, setOllamaUrl] = useState(DEFAULT_OLLAMA_URL);
  const [busy, setBusy] = useState(false);
  const load = (initial = false) => window.bunny.shelfStatus({}).then((next) => {
    setStatus(next);
    if (initial && next.config) {
      setPath(next.config.path);
      setExclude(next.config.exclude.join(", "));
      setModel(next.config.model);
      setOllamaUrl(next.config.ollamaUrl);
    }
  });
  useEffect(() => {
    void load(true).catch(onError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.bunny.onEvent((event) => {
      if (event.type !== "shelf" && event.type !== "changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load().catch(() => {}), 800);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, []);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await load(); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const control = (action: Input<"shelfControl">["action"]) => act(() => window.bunny.shelfControl({ action }));
  const summary = status?.summary;
  const counts = summary?.counts;
  const job = summary?.job;
  const running = job && ["scanning", "indexing"].includes(job.state);
  const ollama = status?.ollama;
  const remote = !isLoopbackUrl(ollamaUrl);
  return <section id="settings-shelf" className="settings-group shelf-settings">
    <h3><LibraryBig size={16} /> 서고</h3>
    <p className="subtle">이미 정리해 둔 PDF 폴더를 읽기 전용으로 색인합니다. 파일을 옮기거나 이름을 바꾸거나 새 파일을 만들지 않습니다. 서고 논문은 모든 프로젝트에서 열람·추천·검색에 쓰이고, 프로젝트에 저장할 때만 아카이브에 들어갑니다.</p>
    <label className="field">서고 위치
      <span className="inline-field">
        <input value={path} placeholder="/Volumes/LIBRARY/Articles" onChange={(e) => setPath(e.target.value)} />
        <button disabled={busy} onClick={() => void window.bunny.chooseShelfRoot({}).then((p) => { if (p) setPath(p); }).catch(onError)}><FolderOpen size={14} />선택</button>
      </span>
    </label>
    <label className="field">제외할 폴더 이름 (쉼표로 구분)
      <input value={exclude} onChange={(e) => setExclude(e.target.value)} />
    </label>
    <label className="field">임베딩 모델
      <input list="shelf-models" value={model} onChange={(e) => setModel(e.target.value)} />
      <datalist id="shelf-models">{ollama?.models.map((m) => <option key={m.name} value={m.name} />)}</datalist>
    </label>
    <details className="settings-advanced">
      <summary>Ollama 주소</summary>
      <label className="field">Ollama 주소<input value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} /></label>
      {remote && <p className="warning-text">이 Mac 밖의 주소입니다. 초록과 검색어가 이 Mac 밖으로 나갑니다.</p>}
    </details>
    <div className="stack-actions">
      <button className="primary" disabled={busy || running || !path.trim()} onClick={() => void act(() => window.bunny.shelfConfigure({
        path: path.trim(),
        exclude: exclude.split(",").map((s) => s.trim()).filter(Boolean),
        model: model.trim() || DEFAULT_EMBED_MODEL,
        ollamaUrl: ollamaUrl.trim() || DEFAULT_OLLAMA_URL,
      }))}>{summary?.configured ? "서고 설정 저장 · 다시 스캔" : "서고 연결"}</button>
    </div>
    {ollama && <p className="subtle">
      Ollama {ollama.running ? `실행 중${ollama.version ? ` ${ollama.version}` : ""}` : "꺼짐 · 열람과 어휘 검색은 그대로 쓸 수 있습니다"}
      {ollama.running && (ollama.modelInstalled ? ` · ${ollama.modelKey}` : ` · ${model} 모델 없음`)}
    </p>}
    {ollama?.running && !ollama.modelInstalled && <div className="inline-actions">
      <code>ollama pull {model}</code>
      <button disabled={busy} onClick={() => void act(() => window.bunny.shelfPull({}))}>앱에서 모델 받기</button>
    </div>}
    {summary?.configured && counts && <>
      <p className="subtle" role="status">
        {running && <LoaderCircle size={13} className="spin" />} {job?.message || "대기 중"}
        {job?.total ? ` · ${(job.done || 0).toLocaleString()}/${job.total.toLocaleString()}` : ""}
      </p>
      <dl className="shelf-counts">
        <div><dt>파일</dt><dd>{counts.files.toLocaleString()}</dd></div>
        <div><dt>논문</dt><dd>{counts.works.toLocaleString()}</dd></div>
        <div><dt>서지 확인 대기</dt><dd>{(counts.stages.found + counts.stages.hashed + counts.stages.extracted).toLocaleString()}</dd></div>
        <div><dt>임베딩</dt><dd>{counts.embedded.toLocaleString()} / {counts.embeddable.toLocaleString()}</dd></div>
        {STATUS_LABELS.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{counts.statuses[key].toLocaleString()}</dd></div>)}
      </dl>
      <p className="subtle">마지막 스캔 {summary.root?.lastScanAt ? new Date(summary.root.lastScanAt).toLocaleString() : "없음"} · 앱이 켜져 있으면 30분마다 다시 스캔합니다.</p>
      <div className="stack-actions">
        <button disabled={busy || running} onClick={() => void control("scan")}><RefreshCw size={14} />다시 스캔</button>
        {job?.state === "paused"
          ? <button disabled={busy} onClick={() => void control("resume")}><Play size={14} />재개</button>
          : <button disabled={busy} onClick={() => void control("pause")}><Pause size={14} />일시정지</button>}
        <button disabled={busy || running || !counts.statuses.failed} onClick={() => void control("retryFailed")}>실패 항목 재시도</button>
        <button disabled={busy || running || !(counts.statuses.review + counts.statuses.provisional)} onClick={() => void control("reresolve")}>확인 필요 다시 조회</button>
        <button disabled={busy || running} onClick={() => void control("reembed")}>임베딩 다시 만들기</button>
        {job?.state === "confirm" && <button disabled={busy} onClick={() => void control("confirmMissing")}>사라진 파일 반영</button>}
      </div>
      {!!status?.failures.length && <details className="settings-advanced">
        <summary>실패 {status.failures.length}건</summary>
        <ul className="shelf-failures">{status.failures.map((f) => <li key={f.fileId}><strong>{f.path}</strong><span className="subtle"> · {f.reason}</span></li>)}</ul>
      </details>}
    </>}
    <p className="subtle">임베딩과 검색어는 이 Mac의 Ollama에서만 처리합니다. 서지 확인에는 DOI와 제목만 OpenAlex·PubMed에 보내고, PDF 본문은 보내지 않습니다.</p>
  </section>;
}
