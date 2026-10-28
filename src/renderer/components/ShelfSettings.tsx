import { useEffect, useState } from "react";
import { ArrowRight, FolderOpen, FolderSync, LibraryBig, LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { DEFAULT_EMBED_MODEL, DEFAULT_OLLAMA_URL, DEFAULT_SHELF_EXCLUDE, isLoopbackUrl, type ShelfAdoptResult, type ShelfMovePreview, type ShelfStatusResult } from "../../shared/shelf";
import type { Input } from "../../shared/contracts";
import type { PassageStatus } from "../../shared/passages";

const STATUS_LABELS: [keyof ShelfStatusResult["summary"]["counts"]["statuses"], string][] = [
  ["ok", "확인됨"], ["review", "확인 필요"], ["provisional", "파일명 서지"], ["auxiliary", "보충자료"], ["failed", "실패"], ["missing", "사라짐"], ["hidden", "앱에서 뺌"],
];

/** What a confirmed folder change does, in the user's terms. */
function moveSummary(move: ShelfMovePreview) {
  const n = (value: number) => value.toLocaleString();
  const lines = {
    first: "",
    same: "",
    remount: `새 위치에서 지금 서고의 파일을 찾았습니다. 색인 ${n(move.keep)}개를 서지·임베딩과 함께 그대로 옮깁니다.`,
    parent: `지금 서고를 포함하는 상위 폴더입니다. 기존 색인 ${n(move.keep)}개는 그대로 두고, 새로 들어오는 폴더만 색인합니다.`,
    subfolder: `지금 서고 안의 폴더입니다. 이 폴더 안의 색인 ${n(move.keep)}개는 그대로 두고, 밖에 있는 ${n(move.drop)}개는 색인에서 뺍니다.`,
    new: `지금 서고와 다른 폴더입니다. 기존 색인 ${n(move.drop)}개를 지우고 이 폴더를 처음부터 색인합니다. 서지 확인은 OpenAlex 하루 예산 안에서 하므로, 큰 서고는 며칠에 걸쳐 끝납니다.`,
  }[move.mode];
  return [
    lines,
    move.links ? `프로젝트 논문 ${n(move.links)}편은 이전 위치의 PDF에 계속 연결됩니다.` : "",
    "파일은 옮기거나 지우지 않습니다. 앞으로 앱이 받는 PDF는 새 위치의 맨 위 폴더(수신함)에 저장합니다.",
  ].filter(Boolean);
}

/** The passage index: PDFs split into passages and passages embedded, with its own pause. */
function PassageIndexStatus({ onError }: { onError: (error: unknown) => void }) {
  const [status, setStatus] = useState<PassageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => window.bunny.passageStatus({}).then(setStatus);
  useEffect(() => {
    void load().catch(onError);
    // Progress events carry the job; counts of scans and failures are reloaded when a pass ends.
    return window.bunny.onEvent((event) => {
      if (event.type !== "passages") return;
      setStatus((current) => current && { ...current, job: event.job });
      if (event.job.state !== "running") void load().catch(() => {});
    });
  }, []);
  const control = async (action: Input<"passageControl">["action"]) => {
    setBusy(true);
    try { await window.bunny.passageControl({ action }); await load(); } catch (error) { onError(error); } finally { setBusy(false); }
  };
  if (!status) return null;
  const { job } = status;
  const running = job.state === "running";
  const left = job.passages.total - job.passages.done;
  return <div className="passage-index" role="group" aria-label="본문 구절 색인">
    <h4>본문 구절 색인</h4>
    <p className="subtle" role="status">
      {running && <LoaderCircle size={13} className="spin" />} {job.message || (job.docs.total ? `PDF ${job.docs.done.toLocaleString()}/${job.docs.total.toLocaleString()}편 색인됨` : "대기 중")}
      {running && job.rate ? ` · 초당 ${job.rate}구절 · 남은 시간 약 ${Math.max(1, Math.round(left / job.rate / 60)).toLocaleString()}분` : ""}
    </p>
    <dl className="shelf-counts">
      <div><dt>PDF</dt><dd>{job.docs.done.toLocaleString()} / {job.docs.total.toLocaleString()}</dd></div>
      <div><dt>구절 임베딩</dt><dd>{job.passages.done.toLocaleString()} / {job.passages.total.toLocaleString()}</dd></div>
      <div><dt>텍스트 없음(스캔)</dt><dd>{status.empty.toLocaleString()}</dd></div>
      <div><dt>읽기 실패</dt><dd>{status.failed.toLocaleString()}</dd></div>
    </dl>
    <div className="stack-actions">
      {job.state === "paused"
        ? <button disabled={busy} onClick={() => void control("resume")}><Play size={14} />본문 색인 재개</button>
        : <button disabled={busy} onClick={() => void control("pause")}><Pause size={14} />본문 색인 일시정지</button>}
      <button disabled={busy || running || job.state === "paused"} onClick={() => void control("run")}><RefreshCw size={14} />지금 이어서 색인</button>
    </div>
    <p className="subtle">PDF 본문을 문단 단위 구절로 나눠 이 Mac의 Ollama로 임베딩합니다. 서고 스캔이 끝날 때마다 새 PDF를 이어서 색인하며, 색인 파일(<code>passages.sqlite</code>)은 지워도 다시 만들 수 있습니다.</p>
  </div>;
}

export function ShelfSettings({ onError, onChanged }: { onError: (error: unknown) => void; onChanged: () => void }) {
  const [status, setStatus] = useState<ShelfStatusResult | null>(null);
  const [path, setPath] = useState("");
  const [exclude, setExclude] = useState(DEFAULT_SHELF_EXCLUDE.join(", "));
  const [model, setModel] = useState(DEFAULT_EMBED_MODEL);
  const [ollamaUrl, setOllamaUrl] = useState(DEFAULT_OLLAMA_URL);
  const [busy, setBusy] = useState(false);
  const [adopted, setAdopted] = useState<ShelfAdoptResult | null>(null);
  const [move, setMove] = useState<ShelfMovePreview | null>(null);
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
  const configured = !!summary?.configured;
  const current = status?.config?.path || "";
  // A configured shelf changes folders only through a preview the user confirms.
  const pathChanged = configured && !!path.trim() && path.trim() !== current;
  const settings = () => ({
    exclude: exclude.split(",").map((s) => s.trim()).filter(Boolean),
    model: model.trim() || DEFAULT_EMBED_MODEL,
    ollamaUrl: ollamaUrl.trim() || DEFAULT_OLLAMA_URL,
  });
  const preview = async (next: string) => {
    setPath(next);
    setMove(null);
    setBusy(true);
    try {
      const result = await window.bunny.shelfMovePreview({ path: next });
      if (result.mode === "same") setPath(current);
      else setMove(result);
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const choose = () => void window.bunny.chooseShelfRoot({}).then((chosen) => {
    if (!chosen) return;
    if (configured) void preview(chosen);
    else setPath(chosen);
  }).catch(onError);
  const cancelMove = () => { setMove(null); setPath(current); };
  return <section id="settings-shelf" className="settings-group shelf-settings">
    <h3><LibraryBig size={16} /> 서고</h3>
    <p className="subtle">이미 정리해 둔 PDF 폴더를 색인합니다. 앱이 내려받거나 가져온 PDF는 서고 맨 위 폴더(수신함)에 <code>연도 - 저자 - 제목.pdf</code>로 저장합니다. 색인은 서고 파일을 옮기거나 이름을 바꾸거나 지우지 않습니다. 파일을 옮기는 것은 수신함 정리에서 승인한 PDF뿐이며, 파일명은 그대로 둡니다. 서고 논문은 모든 프로젝트에서 열람·추천·검색에 쓰이고, 프로젝트에 저장할 때만 아카이브에 들어갑니다.</p>
    <label className="field">서고 위치
      <span className="inline-field">
        <input value={path} placeholder="/Volumes/LIBRARY/Articles" disabled={!!move} onChange={(e) => { setPath(e.target.value); setMove(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && pathChanged) void preview(path.trim()); }} />
        <button disabled={busy || !!move} onClick={choose}><FolderOpen size={14} />{configured ? "다른 폴더 선택" : "선택"}</button>
      </span>
    </label>
    {pathChanged && !move && <div className="inline-actions">
      <button disabled={busy} onClick={() => void preview(path.trim())}>{busy ? <LoaderCircle size={13} className="spin" /> : <FolderSync size={14} />}이 위치로 바꾸기…</button>
      <button className="text-button" disabled={busy} onClick={cancelMove}>되돌리기</button>
    </div>}
    {move && <div className={`shelf-move ${move.mode === "new" ? "warning" : ""}`} role="group" aria-label="서고 위치 변경 확인">
      <p className="shelf-move-path"><span>{move.from}</span><ArrowRight size={13} /><strong>{move.to}</strong></p>
      {moveSummary(move).map((line) => <p key={line}>{line}</p>)}
      <div className="stack-actions">
        <button className="primary" disabled={busy} onClick={() => void act(async () => {
          await window.bunny.shelfConfigure({ path: move.to, ...settings() });
          setMove(null);
          setPath(move.to);
        })}>{busy ? <LoaderCircle size={13} className="spin" /> : null}{move.mode === "new" ? "새 폴더로 바꾸고 다시 색인" : "서고 위치 바꾸기"}</button>
        <button disabled={busy} onClick={cancelMove}>취소</button>
      </div>
    </div>}
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
      <button className="primary" disabled={busy || pathChanged || !!move || !(configured ? current : path.trim())} onClick={() => void act(() => window.bunny.shelfConfigure({
        path: configured ? current : path.trim(),
        ...settings(),
      }))}>{configured ? "서고 설정 저장 · 다시 스캔" : "서고 연결"}</button>
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
      {(!!status?.managed || adopted) && <div className="inline-actions">
        <span className="subtle" role="status">{adopted
          ? `수신함으로 옮김 ${adopted.moved}개 · 서고 파일에 연결 ${adopted.linked}개${adopted.kept.length ? ` · 서고에 다른 파일로 있어 그대로 둠 ${adopted.kept.length}편` : ""}${adopted.failed.length ? ` · 실패 ${adopted.failed.length}개` : ""}`
          : `앱 폴더에 보관 중인 PDF ${status!.managed.toLocaleString()}개`}</span>
        {!!status?.managed && <button disabled={busy || running} onClick={() => void act(async () => setAdopted(await window.bunny.shelfAdopt({})))}>서고 수신함으로 옮기기</button>}
      </div>}
      {!!status?.failures.length && <details className="settings-advanced">
        <summary>실패 {status.failures.length}건</summary>
        <ul className="shelf-failures">{status.failures.map((f) => <li key={f.fileId}><strong>{f.path}</strong><span className="subtle"> · {f.reason}</span></li>)}</ul>
      </details>}
      <PassageIndexStatus onError={onError} />
    </>}
    <p className="subtle">임베딩과 검색어는 이 Mac의 Ollama에서만 처리합니다. 서지 확인에는 DOI와 제목만 OpenAlex·PubMed에 보냅니다. AI 답변과 보고서는 근거가 되는 논문 본문을 연결된 AI(Codex·Claude 등)에 보냅니다.</p>
  </section>;
}
