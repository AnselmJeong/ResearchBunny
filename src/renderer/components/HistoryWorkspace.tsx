import { useEffect, useState } from "react";
import { ChevronRight, History } from "lucide-react";
import type { DiscoveryMode, Run, WorkView } from "../../shared/types";
import { runPath, type WorkspaceView } from "../../shared/navigation";
import { ImportResults } from "./ImportResults";
import { DownloadResults } from "./DownloadResults";

export function HistoryWorkspace({
  runs,
  projectId,
  currentId,
  views,
  labels,
  onOpen,
  onError,
  busy,
  onResume,
}: {
  runs: Run[];
  projectId: string;
  currentId: string;
  views: Record<string, WorkspaceView>;
  labels: Record<DiscoveryMode, string>;
  onOpen: (run: Run) => void;
  onError: (error: unknown) => void;
  busy: boolean;
  onResume: (id: string) => Promise<unknown>;
}) {
  const [focusedId, setFocusedId] = useState(currentId || runs[0]?.id);
  const [papers, setPapers] = useState<WorkView[]>([]);
  const focused = runs.find((r) => r.id === focusedId) || runs[0];
  const saved = focused ? views[`run:${focused.id}`] : undefined;
  const filters = saved?.filters || focused?.filters;
  useEffect(() => {
    let cancelled = false;
    setPapers([]);
    if (focused)
      void Promise.all(
        focused.inputIds.map((workId) =>
          window.bunny.inspect({ projectId, workId }),
        ),
      )
        .then((items) => {
          if (!cancelled) setPapers(items);
        })
        .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [focused?.id, projectId]);
  const ids = new Set(runs.map((r) => r.id));
  const roots = runs.filter((r) => !r.parentId || !ids.has(r.parentId));
  // Guard legacy/corrupt cycles without inventing a chronological parent.
  const reachable = new Set<string>();
  const mark = (r: Run) => {
    if (reachable.has(r.id)) return;
    reachable.add(r.id);
    runs.filter((c) => c.parentId === r.id).forEach(mark);
  };
  roots.forEach(mark);
  for (const r of runs)
    if (!reachable.has(r.id)) {
      roots.push(r);
      mark(r);
    }
  const renderStage = (r: Run, depth: number, ancestors: Set<string>) => {
    const seen = new Set(ancestors).add(r.id);
    const children = runs.filter((c) => c.parentId === r.id && !seen.has(c.id));
    const selected = views[`run:${r.id}`]?.selected;
    return (
      <li
        key={r.id}
        className="history-branch"
        data-run-id={r.id}
        data-parent-id={r.parentId || ""}
      >
        <article
          className={`history-stage ${r.id === currentId ? "current" : ""} ${r.id === focused?.id ? "focused" : ""}`}
        >
          <button
            className="stage-select"
            onClick={() => setFocusedId(r.id)}
            aria-pressed={r.id === focused?.id}
          >
            <span className="stage-number">{depth}</span>
            <span className="stage-content">
              <strong>{r.download ? "PDF 원문 확보" : r.import ? "PDF 가져오기" : labels[r.mode]}</strong>
              {r.id === currentId && (
                <span className="current-label">현재 단계</span>
              )}
              <span className="stage-query">
                {r.query || `출발 문헌 ${r.inputIds.length}편`}
              </span>
              <span className="subtle">
                {r.count}편 {r.download ? "PDF 보관" : "발견"}{selected ? ` · ${selected.length}편 선택` : ""}
              </span>
              <time>
                {new Date(r.createdAt).toLocaleString("ko-KR", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </span>
          </button>
          <button
            className="stage-open"
            disabled={busy}
            data-help="이 단계에 저장된 선택 문헌과 필터를 복원합니다."
            onClick={() => onOpen(r)}
          >
            이 단계로 이동 <ChevronRight size={14} />
          </button>
        </article>
        {children.length > 0 && (
          <ol className="history-children">
            {children.map((child) => renderStage(child, depth + 1, seen))}
          </ol>
        )}
      </li>
    );
  };
  return (
    <div className="history-workspace">
      <main className="history-main">
        <header className="workspace-heading">
          <div>
            <h1>탐색 이력</h1>
            <p className="subtle">선택했던 문헌과 조건을 그대로 이어가세요.</p>
          </div>
          <span className="subtle">최근 탐색부터</span>
        </header>
        {runs.length ? (
          <ol className="history-tree">
            {roots.map((r) => renderStage(r, 1, new Set()))}
          </ol>
        ) : (
          <div className="empty-state">
            <History size={30} />
            <h2>아직 탐색 기록이 없습니다.</h2>
            <p>검색하고 문헌을 탐색하면 출발 단계와 분기가 여기에 남습니다.</p>
          </div>
        )}
        <p className="history-count subtle">
          {runs.length}개 탐색 단계 · 로컬에 보관
        </p>
      </main>
      {focused && (
        <aside className="inspector history-inspector">
          <div className="inspector-heading">단계 상세</div>
          <div className="inspector-scroll">
            <h2>
              <span className="stage-number">
                {runPath(runs, focused.id).length}
              </span>
              {focused.download ? "PDF 원문 확보" : focused.import ? "PDF 가져오기" : labels[focused.mode]}
            </h2>
            <p className="subtle">{focused.message}</p>
            <section>
              <h3>출발 문헌 {focused.inputIds.length}편</h3>
              {papers.length ? (
                <ol className="stage-papers">
                  {papers.map((w) => (
                    <li key={w.id}>
                      {w.title}
                      <small>
                        {w.authors.slice(0, 2).join(" · ")} ·{" "}
                        {w.year || "연도 미상"}
                      </small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="subtle">
                  {focused.inputIds.length
                    ? "문헌 정보를 불러오는 중…"
                    : focused.query || "직접 가져온 문헌"}
                </p>
              )}
            </section>
            <section>
              <h3>필터</h3>
              <p className="subtle">
                {filters?.yearFrom || filters?.yearTo
                  ? `${filters.yearFrom || "전체"}–${filters.yearTo || "현재"}`
                  : "연도 제한 없음"}
                <br />
                최소 인용 {filters?.minCitations || 0}회 · 관련성{" "}
                {filters?.relevance ? filters.strictness : "제한 없음"}
              </p>
            </section>
            <section>
              <h3>정렬</h3>
              <p className="subtle">
                {
                  {
                    rank: "기본 순서",
                    year: "최신순",
                    citations: "피인용수순",
                    title: "제목순",
                    updated: "최근 편집순",
                  }[saved?.sort || "rank"]
                }
              </p>
            </section>
            <button
              className="primary stage-restore"
              disabled={busy}
              onClick={() => onOpen(focused)}
            >
              이 단계로 이동 <ChevronRight size={15} />
            </button>
            <p className="subtle">기존 탐색 결과는 그대로 보존됩니다.</p>
            {focused.import && (
              <ImportResults
                runId={focused.id}
                busy={busy}
                onError={onError}
                onResume={() => onResume(focused.id)}
              />
            )}
            {focused.download && <DownloadResults run={focused} busy={busy} onError={onError} onResume={() => onResume(focused.id)} />}
            <details className="history-details">
              <summary>조회·필터 상세</summary>
              <p className="subtle">
                API {focused.calls}/{focused.maxCalls}회 · {focused.status} ·{" "}
                {focused.rankingVersion}
              </p>
              <pre>
                {JSON.stringify(
                  { filters, tasks: focused.tasks, ai: focused.ai },
                  null,
                  2,
                )}
              </pre>
            </details>
            {!busy && focused.status !== "completed" && (
              <button onClick={() => onResume(focused.id)}>재개</button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
