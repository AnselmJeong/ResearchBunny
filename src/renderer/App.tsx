import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  Plus,
  ArrowUpRight,
  ArrowRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Download,
  FileText,
  Folder,
  History,
  Inbox,
  List,
  LoaderCircle,
  MoreHorizontal,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Trash2,
  Upload,
  X,
  Calendar,
  Leaf,
  Tags,
  Archive,
  AlertCircle,
} from "lucide-react";
import type {
  Snapshot,
  ListResult,
  WorkView,
  Filters as FilterValues,
  DiscoveryMode,
  Run,
  LibraryState,
} from "../shared/types";
import { DEFAULT_FILTERS } from "../shared/types";
import type { Input } from "../shared/contracts";
import { Graph } from "./components/Graph";
import { Filters } from "./components/Filters";
import { Inspector } from "./components/Inspector";
import { Modal } from "./components/Modal";
import { Settings } from "./components/Settings";
import { ImportResults } from "./components/ImportResults";
import {
  ImportDialog,
  WorkEditor,
  SeedDialog,
  ExportDialog,
} from "./components/Dialogs";
const MODES: Record<DiscoveryMode, string> = {
  search: "검색 결과",
  related: "관련 논문",
  references: "참고문헌",
  citedBy: "후속 인용",
  commonReferences: "공통 참고문헌",
  commonCiting: "공통 후속 연구",
  ai: "핵심 논문 추천",
};
const READ = {
  unread: "미열람",
  planned: "읽을 예정",
  reading: "읽는 중",
  read: "읽음",
};
const EMPTY: ListResult = {
  works: [],
  total: 0,
  hidden: 0,
  deferred: 0,
  ids: [],
  edges: [],
};
type Scope = Input<"list">["scope"];
type Dialog =
  | "settings"
  | "import"
  | "manual"
  | "edit"
  | "seeds"
  | "export"
  | "project"
  | "collection"
  | "history"
  | "bulk"
  | null;
function Bunny({ size = 27 }: { size?: number }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
      <path
        d="M12 21C5 3 13-3 18 17C20-4 29 0 25 20C37 26 30 37 20 37C9 37 3 27 12 21Z"
        fill="currentColor"
      />
      <circle cx="15.5" cy="27" r="1.6" fill="var(--sidebar)" />
      <circle cx="25.2" cy="27" r="1.6" fill="var(--sidebar)" />
      <path d="M19 30h3l-1.5 2Z" fill="var(--sidebar)" />
    </svg>
  );
}
export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [projectId, setProjectId] = useState(""),
    [scope, setScope] = useState<Scope>("archive"),
    [scopeId, setScopeId] = useState("");
  const [query, setQuery] = useState(""),
    [localQuery, setLocalQuery] = useState(""),
    [sort, setSort] = useState<
      "rank" | "year" | "citations" | "title" | "updated"
    >("rank"),
    [searchSort, setSearchSort] = useState<"relevance" | "citations" | "year">(
      "relevance",
    ),
    [semantic, setSemantic] = useState(false);
  const [filters, setFilters] = useState<FilterValues>({ ...DEFAULT_FILTERS }),
    [filtersOpen, setFiltersOpen] = useState(false),
    [showHidden, setShowHidden] = useState(false),
    [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<ListResult>(EMPTY),
    [selected, setSelected] = useState<string[]>([]),
    [inspectorId, setInspectorId] = useState<string | null>(null),
    [inspected, setInspected] = useState<WorkView | null>(null),
    [inspectorOpen, setInspectorOpen] = useState(true);
  const [view, setView] = useState<"list" | "graph" | "timeline">("list"),
    [positions, setPositions] = useState<
      Record<string, { x: number; y: number }>
    >({});
  const [dialog, setDialog] = useState<Dialog>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [name, setName] = useState(""),
    [question, setQuestion] = useState(""),
    [bulkReason, setBulkReason] = useState(""),
    [bulkTags, setBulkTags] = useState(""),
    [bulkCollection, setBulkCollection] = useState(""),
    [basis, setBasis] = useState<"selected" | "archive">("selected");
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; projectId: string; failed?: boolean }>
  >({});
  const initialized = useRef(""),
    noteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({}),
    lastIndex = useRef<number | null>(null),
    searchInput = useRef<HTMLInputElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flash = useCallback((text: string, error = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, error });
    if (!error) toastTimer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  const onError = useCallback(
    (error: unknown) => {
      if (error)
        flash(error instanceof Error ? error.message : String(error), true);
    },
    [flash],
  );
  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  useEffect(
    () =>
      window.bunny.onEvent((event) => {
        if (event.type === "service-error")
          flash(event.message || "자료 서비스 오류", true);
        refresh();
      }),
    [refresh, flash],
  );
  useEffect(() => {
    let valid = true;
    void window.bunny
      .snapshot(projectId ? { projectId } : {})
      .then((data) => {
        if (!valid) return;
        setSnapshot(data);
        const current = projectId || data.projects[0].id;
        if (!projectId) {
          setProjectId(current);
          return;
        }
        document.documentElement.dataset.theme = data.settings.theme;
        if (initialized.current !== current) {
          initialized.current = current;
          const ui = data.ui as any;
          setScope(ui.scope || "archive");
          setScopeId(ui.scopeId || "");
          setFilters({ ...DEFAULT_FILTERS, ...ui.filters });
          setSelected(ui.selected || []);
          setInspectorId(ui.inspectorId || null);
          setView(ui.view || "list");
          setPositions(ui.positions || {});
          setQuery(ui.query || "");
          setLocalQuery(ui.localQuery || "");
          setQuestion(
            data.projects.find((p) => p.id === current)?.question || "",
          );
          setList(EMPTY);
          setRevision((r) => r + 1);
        }
      })
      .catch(onError);
    return () => {
      valid = false;
    };
  }, [projectId, revision, onError]);
  useEffect(() => {
    if (!projectId || initialized.current !== projectId) return;
    let valid = true;
    setLoading(true);
    const timer = setTimeout(() => {
      if ((scope === "run" || scope === "collection") && !scopeId) {
        setList(EMPTY);
        setLoading(false);
        return;
      }
      void window.bunny
        .list({
          projectId,
          scope,
          scopeId: scopeId || undefined,
          query: localQuery,
          filters,
          showHidden,
          limit,
          offset,
          sort,
        })
        .then((result) => {
          if (valid) setList(result);
        })
        .catch(onError)
        .finally(() => {
          if (valid) setLoading(false);
        });
    }, 100);
    return () => {
      valid = false;
      clearTimeout(timer);
    };
  }, [
    projectId,
    scope,
    scopeId,
    localQuery,
    filters,
    showHidden,
    limit,
    offset,
    sort,
    revision,
    onError,
  ]);
  useEffect(() => {
    if (!projectId || !inspectorId) {
      setInspected(null);
      return;
    }
    let valid = true;
    void window.bunny
      .inspect({
        projectId,
        workId: inspectorId,
        runId: scope === "run" ? scopeId || undefined : undefined,
      })
      .then((w) => {
        if (valid) setInspected(w);
      })
      .catch((e) => {
        if (valid) {
          setInspected(null);
          onError(e);
        }
      });
    return () => {
      valid = false;
    };
  }, [projectId, inspectorId, scope, scopeId, revision, onError]);
  useEffect(() => {
    if (!projectId || initialized.current !== projectId) return;
    const timer = setTimeout(
      () =>
        void window.bunny
          .saveUi({
            projectId,
            value: {
              scope,
              scopeId,
              selected,
              inspectorId,
              view,
              filters,
              positions,
              query,
              localQuery,
            },
          })
          .catch(onError),
      500,
    );
    return () => clearTimeout(timer);
  }, [
    projectId,
    scope,
    scopeId,
    selected,
    inspectorId,
    view,
    filters,
    positions,
    query,
    localQuery,
    onError,
  ]);
  useEffect(() => {
    for (const [id, draft] of Object.entries(drafts)) {
      if (noteTimers.current[id]) clearTimeout(noteTimers.current[id]);
      if (draft.failed) continue;
      noteTimers.current[id] = setTimeout(() => {
        void window.bunny
          .mutateWorks({
            projectId: draft.projectId,
            ids: [id],
            patch: { note: draft.text },
          })
          .then(() =>
            setDrafts((current) => {
              if (current[id]?.text !== draft.text) return current;
              const next = { ...current };
              delete next[id];
              return next;
            }),
          )
          .catch((error) => {
            setDrafts((current) =>
              current[id]?.text === draft.text
                ? { ...current, [id]: { ...draft, failed: true } }
                : current,
            );
            onError(error);
          });
        delete noteTimers.current[id];
      }, 650);
    }
    return () => {
      for (const timer of Object.values(noteTimers.current))
        clearTimeout(timer);
    };
  }, [drafts, onError]);
  const currentRun = snapshot?.runs.find((r) => r.id === scopeId);
  const active = snapshot?.runs.find(
    (r) => r.status === "running" || r.status === "queued",
  );
  const seeds = useMemo(
    () => snapshot?.seeds?.ids || [],
    [snapshot?.seeds?.id],
  );
  const navigate = (next: Scope, id = "") => {
    setList(EMPTY);
    setLoading(true);
    setOffset(0);
    setScope(next);
    setScopeId(id);
    setLocalQuery("");
    setSelected([]);
    setLimit(50);
    setFilters({
      ...DEFAULT_FILTERS,
      relevance:
        next === "run" &&
        snapshot?.runs.find((r) => r.id === id)?.mode === "related",
      hideExcluded: next !== "excluded",
    });
    setShowHidden(false);
    setInspectorId(null);
  };
  const inspect = (id: string) => {
    setInspectorId(id);
    setInspectorOpen(true);
  };
  const task = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    try {
      await fn();
      if (message) flash(message);
      refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const patch = (
    ids: string[],
    update: Partial<LibraryState>,
    message?: string,
  ) =>
    void task(
      () => window.bunny.mutateWorks({ projectId, ids, patch: update }),
      message,
    );
  const openRun = (run: Run) => {
    navigate("run", run.id);
    setFilters({ ...run.filters });
    setQuery(run.query);
  };
  const discover = async (mode: DiscoveryMode, ids?: string[]) => {
    let startIds = ids || (selected.length ? selected : seeds);
    if (
      ["commonReferences", "commonCiting"].includes(mode) &&
      basis === "archive"
    )
      startIds = (
        await window.bunny.list({
          projectId,
          scope: "archive",
          filters: {
            ...DEFAULT_FILTERS,
            hideExcluded: false,
            hideRetracted: false,
          },
          limit: 1,
        })
      ).ids;
    const nextFilters = {
      ...filters,
      relevance: mode === "related" || mode === "ai",
    };
    await task(async () => {
      const r = await window.bunny.startRun({
        projectId,
        mode,
        query: query || snapshot?.seeds?.question || "",
        ids: mode === "search" || mode === "ai" ? [] : startIds,
        filters: nextFilters,
        sort: searchSort,
        semantic,
        parentId: scope === "run" ? scopeId || undefined : undefined,
      });
      openRun(r);
      setSelected([]);
    });
  };
  const toggle = (id: string, index: number, shift = false) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastIndex.current !== null) {
        const min = Math.min(lastIndex.current, index),
          max = Math.max(lastIndex.current, index);
        for (const w of list.works.slice(min, max + 1)) next.add(w.id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return [...next];
    });
    lastIndex.current = index;
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const editable = (e.target as HTMLElement)?.closest(
        "input,textarea,select,[contenteditable=true]",
      );
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInput.current?.focus();
      }
      if (editable || dialog) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        setSelected(list.works.map((w) => w.id));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (selected.length)
          patch(
            selected,
            { screening: "included" },
            `${selected.length}편 저장됨`,
          );
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        setDialog("export");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected, list, dialog, projectId]);
  const title =
    scope === "run"
      ? currentRun
        ? currentRun.import
          ? "PDF 가져오기"
          : MODES[currentRun.mode]
        : "문헌 탐색"
      : scope === "collection"
        ? snapshot?.collections.find((c) => c.id === scopeId)?.name || "컬렉션"
        : {
            archive: "내 아카이브",
            pending: "검토 대기함",
            starred: "핵심 문헌",
            reading: "읽기 목록",
            trash: "휴지통",
            excluded: "제외 문헌",
          }[scope] || "문헌";
  const hiddenSelected = selected.filter(
    (id) => !list.ids.includes(id) && !list.context?.some((w) => w.id === id),
  ).length;
  const currentProject = snapshot?.projects.find((p) => p.id === projectId);
  const failedNotes = Object.entries(drafts).filter(([, d]) => d.failed);
  if (!snapshot)
    return (
      <div className="app-loading">
        <Bunny size={44} />
        <h1>ResearchBunny</h1>
        <p>{toast?.error ? toast.text : "라이브러리를 여는 중…"}</p>
        {toast?.error && <button onClick={refresh}>다시 시도</button>}
      </div>
    );
  return (
    <div
      className="app-shell"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const paths = window.bunny.droppedPaths(
          Array.from(e.dataTransfer.files),
        );
        if (paths.length)
          void task(async () =>
            openRun(await window.bunny.importDropped({ projectId, paths })),
          );
      }}
    >
      <aside className="sidebar">
        <div className="drag-region" />
        <div className="brand">
          <Bunny />
          <strong>ResearchBunny</strong>
        </div>
        <div className="project-switch">
          <span className="project-monogram">
            {currentProject?.name[0] || "R"}
          </span>
          <select
            aria-label="프로젝트"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setSelected([]);
              setInspectorId(null);
            }}
          >
            {snapshot.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            title="새 프로젝트"
            onClick={() => {
              setName("");
              setQuestion("");
              setDialog("project");
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav>
          <button
            className={scope === "run" ? "active" : ""}
            onClick={() => navigate("run", snapshot.runs[0]?.id || "")}
          >
            <Compass size={17} />
            문헌 탐색
          </button>
          <div className="nav-label">라이브러리</div>
          {(
            [
              { key: "archive", label: "내 아카이브", icon: BookOpen },
              { key: "pending", label: "검토 대기함", icon: Inbox },
              { key: "starred", label: "핵심 문헌", icon: Star },
              { key: "reading", label: "읽기 목록", icon: Bookmark },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={scope === key ? "active" : ""}
              onClick={() => navigate(key)}
            >
              <Icon size={17} />
              {label}
              <span className="nav-count">{snapshot.counts[key] || 0}</span>
            </button>
          ))}
          <div className="nav-label">
            컬렉션
            <button
              className="icon-button"
              title="새 컬렉션"
              onClick={() => {
                setName("");
                setDialog("collection");
              }}
            >
              <Plus size={14} />
            </button>
          </div>
          {snapshot.collections.length ? (
            snapshot.collections.map((c) => (
              <button
                key={c.id}
                className={
                  scope === "collection" && scopeId === c.id ? "active" : ""
                }
                onClick={() => navigate("collection", c.id)}
              >
                <Folder size={16} />
                <span className="ellipsis">{c.name}</span>
                <span className="nav-count">{c.count}</span>
              </button>
            ))
          ) : (
            <p className="nav-empty">주제별로 문헌을 묶어보세요.</p>
          )}
          <div className="nav-label">
            최근 탐색
            <button
              className="icon-button"
              title="탐색 이력"
              onClick={() => setDialog("history")}
            >
              <History size={14} />
            </button>
          </div>
          {snapshot.runs.slice(0, 5).map((r) => (
            <button
              className="recent-run"
              key={r.id}
              onClick={() => openRun(r)}
            >
              {["running", "queued"].includes(r.status) ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <History size={14} />
              )}
              <span className="ellipsis">{r.query || MODES[r.mode]}</span>
            </button>
          ))}
          {!snapshot.runs.length && (
            <p className="nav-empty">탐색 경로가 여기에 남습니다.</p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setDialog("import")}>
            <Upload size={16} />
            문헌 가져오기
          </button>
          <button onClick={() => navigate("excluded")}>
            <Archive size={15} />
            제외 문헌
            <span className="nav-count">{snapshot.counts.excluded}</span>
          </button>
          <button onClick={() => navigate("trash")}>
            <Trash2 size={15} />
            휴지통<span className="nav-count">{snapshot.counts.trash}</span>
          </button>
          <button onClick={() => setDialog("settings")}>
            <SettingsIcon size={16} />
            설정
            <span className="local-dot" />
            로컬
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            {currentProject?.name}
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <button
              title="직전 라이브러리 변경 되돌리기"
              className="icon-button"
              onClick={() =>
                void task(async () => {
                  flash(
                    (await window.bunny.undo({ projectId }))
                      ? "직전 변경을 되돌렸습니다."
                      : "되돌릴 변경이 없습니다.",
                  );
                })
              }
            >
              <RotateCcw size={16} />
            </button>
            <button onClick={() => setDialog("export")}>
              <Download size={15} />
              내보내기
            </button>
            <button
              className="icon-button"
              title="상세 패널 전환"
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              {inspectorOpen ? (
                <PanelRightClose size={17} />
              ) : (
                <PanelRightOpen size={17} />
              )}
            </button>
          </div>
        </header>
        <div className="search-section">
          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              void discover("search").catch(onError);
            }}
          >
            <Search size={20} />
            <input
              ref={searchInput}
              aria-label="논문 검색"
              placeholder="연구 주제, 제목, DOI로 논문 찾기"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>⌘ K</kbd>
            <button
              className="primary"
              disabled={busy || !!active || !query.trim()}
              type="submit"
            >
              검색
              <ArrowRight size={15} />
            </button>
          </form>
          <div className="search-options">
            <label>
              <select
                aria-label="검색 정렬"
                value={searchSort}
                onChange={(e) =>
                  setSearchSort(e.target.value as typeof searchSort)
                }
              >
                <option value="relevance">검색 관련순</option>
                <option value="citations">피인용수순</option>
                <option value="year">최신순</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={semantic}
                onChange={(e) => setSemantic(e.target.checked)}
              />
              의미 검색
            </label>
            <span className="search-provider">
              OpenAlex
              {!snapshot.settings.openalexConfigured && (
                <button
                  className="text-button"
                  onClick={() => setDialog("settings")}
                >
                  API 키 설정
                </button>
              )}
            </span>
            <button
              className="ai-button"
              disabled={busy || !!active || !query.trim()}
              onClick={() => {
                if (
                  !snapshot.settings.aiEnabled ||
                  !snapshot.settings.openaiConfigured
                ) {
                  setDialog("settings");
                  flash(
                    "핵심 논문 추천은 설정에서 OpenAI 키와 사용 여부를 등록하세요.",
                  );
                } else void discover("ai").catch(onError);
              }}
            >
              <Sparkles size={15} />
              핵심 논문 찾기<span className="badge">실험</span>
            </button>
          </div>
        </div>
        <div className="seed-strip">
          <div>
            <Leaf size={15} />
            <strong>초기 관심</strong>
            {seeds.length ? (
              <>
                <span>{seeds.length}편 고정</span>
                <span className="seed-question">
                  {snapshot.seeds?.question || "seed의 제목·초록·주제 기준"}
                </span>
              </>
            ) : (
              <span>논문을 선택해 관심 기준을 정하세요.</span>
            )}
          </div>
          <button className="text-button" onClick={() => setDialog("seeds")}>
            {seeds.length ? "기준 변경" : "seed 지정"}
            <ChevronRight size={13} />
          </button>
        </div>
        <div className="workspace">
          <main className="workspace-main">
            <div className="workspace-heading">
              <div>
                <div className="eyebrow">
                  {scope === "run" ? "DISCOVER" : "LIBRARY"}
                </div>
                <h1>
                  {title}
                  <span>{list.total.toLocaleString()}</span>
                </h1>
              </div>
              <div className="view-switch">
                {(
                  [
                    { key: "list", icon: List, label: "목록" },
                    { key: "graph", icon: Network, label: "그래프" },
                    { key: "timeline", icon: Calendar, label: "연도" },
                  ] as const
                ).map(({ key, icon: Icon, label }) => (
                  <button
                    aria-label={`${label} 보기`}
                    key={key}
                    className={view === key ? "active" : ""}
                    onClick={() => setView(key)}
                  >
                    <Icon size={16} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
            {scope === "run" && currentRun && (
              <div className="run-context">
                <span>{currentRun.query || "선택한 문헌의 한 단계 확장"}</span>
                <button
                  className="text-button"
                  onClick={() => setDialog("history")}
                >
                  기록 보기
                  <ArrowUpRight size={12} />
                </button>
              </div>
            )}
            <div className="discovery-toolbar">
              <span className="subtle">
                확장 대상 {selected.length || seeds.length}편
              </span>
              <button
                disabled={!!active || !(selected.length || seeds.length)}
                onClick={() => void discover("related").catch(onError)}
              >
                관련 논문
              </button>
              <button
                disabled={!!active || !(selected.length || seeds.length)}
                onClick={() => void discover("references").catch(onError)}
              >
                참고문헌
              </button>
              <button
                disabled={!!active || !(selected.length || seeds.length)}
                onClick={() => void discover("citedBy").catch(onError)}
              >
                후속 인용
              </button>
              <details className="dropdown">
                <summary>
                  공통 관계
                  <ChevronDown size={13} />
                </summary>
                <div>
                  <label className="field">
                    집계 기준
                    <select
                      value={basis}
                      onChange={(e) => setBasis(e.target.value as typeof basis)}
                    >
                      <option value="selected">선택 문헌 / 초기 seed</option>
                      <option value="archive">프로젝트 아카이브</option>
                    </select>
                  </label>
                  <button
                    disabled={!!active}
                    onClick={() =>
                      void discover("commonReferences").catch(onError)
                    }
                  >
                    공통 참고문헌
                  </button>
                  <button
                    disabled={!!active}
                    onClick={() => void discover("commonCiting").catch(onError)}
                  >
                    여러 편을 인용한 후속 연구
                  </button>
                </div>
              </details>
            </div>
            <div className="list-toolbar">
              <div className="local-search">
                <Search size={14} />
                <input
                  aria-label="현재 문헌에서 찾기"
                  placeholder="현재 문헌에서 찾기"
                  value={localQuery}
                  onChange={(e) => setLocalQuery(e.target.value)}
                />
              </div>
              <button
                className={filtersOpen ? "active" : ""}
                onClick={() => setFiltersOpen(!filtersOpen)}
              >
                <SlidersHorizontal size={14} />
                필터{list.hidden > 0 && <span>{list.hidden}</span>}
              </button>
              <select
                aria-label="목록 정렬"
                value={sort}
                onChange={(e) => setSort(e.target.value as typeof sort)}
              >
                <option value="rank">기본 순서</option>
                <option value="year">최신순</option>
                <option value="citations">피인용수순</option>
                <option value="title">제목순</option>
                <option value="updated">최근 편집순</option>
              </select>
              <button
                className="icon-button"
                title="문헌 직접 등록"
                onClick={() => setDialog("manual")}
              >
                <Plus size={16} />
              </button>
            </div>
            {filtersOpen && <Filters value={filters} onChange={setFilters} />}
            {(list.hidden > 0 || showHidden) && (
              <div className="hidden-banner">
                <span>
                  필터로 숨김 {list.hidden}편
                  {list.deferred
                    ? ` · 관련성 판단 보류 ${list.deferred}편`
                    : ""}
                </span>
                <button
                  className="text-button"
                  onClick={() => setShowHidden(!showHidden)}
                >
                  {showHidden ? "필터 적용" : "숨긴 결과와 이유 보기"}
                </button>
              </div>
            )}
            {selected.length > 0 && (
              <div className="selection-bar">
                <label>
                  <input
                    type="checkbox"
                    checked={
                      list.works.length > 0 &&
                      list.works.every((w) => selected.includes(w.id))
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [
                              ...new Set([
                                ...selected,
                                ...list.works.map((w) => w.id),
                              ]),
                            ]
                          : [],
                      )
                    }
                  />
                  <strong>{selected.length}편 선택</strong>
                  {hiddenSelected > 0 && <span>({hiddenSelected}편 숨김)</span>}
                </label>
                <button
                  onClick={() =>
                    patch(
                      selected,
                      { screening: "included" },
                      `${selected.length}편을 저장했습니다.`,
                    )
                  }
                >
                  <Bookmark size={14} />
                  저장
                </button>
                <button onClick={() => setDialog("seeds")}>
                  <Leaf size={14} />
                  seed
                </button>
                <button onClick={() => setDialog("export")}>
                  <Download size={14} />
                  내보내기
                </button>
                <button title="일괄 편집" onClick={() => setDialog("bulk")}>
                  <MoreHorizontal size={17} />
                </button>
                <button
                  className="icon-button"
                  title="선택 해제"
                  onClick={() => setSelected([])}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {scope === "run" && !!list.context?.length && (
              <details className="graph-context">
                <summary>
                  출발·초기 기준 문헌 {list.context.length}편 · 후보 집계와 별도
                  표시
                </summary>
                <div>
                  {list.context.map((w) => (
                    <label key={w.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(w.id)}
                        onChange={(e) =>
                          setSelected((ids) =>
                            e.target.checked
                              ? [...new Set([...ids, w.id])]
                              : ids.filter((id) => id !== w.id),
                          )
                        }
                      />
                      <button onClick={() => inspect(w.id)}>{w.title}</button>
                    </label>
                  ))}
                </div>
              </details>
            )}
            <div className="results-area">
              {loading && !list.works.length ? (
                <div className="results-loading">
                  <LoaderCircle size={24} className="spin" />
                  <span>문헌을 불러오는 중…</span>
                </div>
              ) : !list.works.length ? (
                <div className="empty-state">
                  <div className="empty-graphic">
                    <div className="orbit-node n1" />
                    <div className="orbit-node n2" />
                    <div className="orbit-node n3" />
                    <div className="orbit-line l1" />
                    <div className="orbit-line l2" />
                    <div className="orbit-line l3" />
                    <div className="center-bunny">
                      <Bunny size={48} />
                    </div>
                  </div>
                  <h2>
                    {list.hidden
                      ? "조건에 맞는 문헌이 없습니다."
                      : scope === "archive"
                        ? "첫 문헌부터 시작하세요."
                        : scope === "pending"
                          ? "검토를 기다리는 문헌이 없습니다."
                          : scope === "run"
                            ? "연구의 출발점을 찾아보세요."
                            : `아직 ${title}이 없습니다.`}
                  </h2>
                  <p>
                    {list.hidden
                      ? "필터를 조정하거나 숨긴 결과를 복원하세요."
                      : "주제나 DOI로 검색하고 관심 논문을 골라보세요. 기존 BibTeX와 PDF로도 시작할 수 있습니다."}
                  </p>
                  <div className="inline-actions">
                    <button
                      className="primary"
                      onClick={() => searchInput.current?.focus()}
                    >
                      <Search size={16} />
                      논문 검색
                    </button>
                    <button onClick={() => setDialog("import")}>
                      <Upload size={16} />
                      문헌 가져오기
                    </button>
                  </div>
                  <button
                    className="text-button manual-start"
                    onClick={() => setDialog("manual")}
                  >
                    문헌 직접 등록
                    <ArrowUpRight size={12} />
                  </button>
                </div>
              ) : view === "list" ? (
                <>
                  <div className="table-heading">
                    <input
                      aria-label="이 페이지 전체 선택"
                      type="checkbox"
                      checked={list.works.every((w) => selected.includes(w.id))}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [
                                ...new Set([
                                  ...selected,
                                  ...list.works.map((w) => w.id),
                                ]),
                              ]
                            : selected.filter(
                                (id) => !list.works.some((w) => w.id === id),
                              ),
                        )
                      }
                    />
                    <span>논문</span>
                    <span>연도</span>
                    <span>피인용</span>
                    <span />
                  </div>
                  <div className="paper-list">
                    {list.works.map((w, index) => (
                      <article
                        key={w.id}
                        className={
                          "paper-row " +
                          (selected.includes(w.id) ? "selected " : "") +
                          (inspectorId === w.id ? "inspected " : "") +
                          (w.evidence?.hidden.length ? "filtered" : "")
                        }
                      >
                        <input
                          type="checkbox"
                          aria-label={`${w.title} 선택`}
                          checked={selected.includes(w.id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(w.id, index, e.shiftKey);
                          }}
                          onChange={() => {}}
                        />
                        <button
                          className="paper-main"
                          onClick={() => inspect(w.id)}
                        >
                          <h3>{w.title}</h3>
                          <p>
                            {w.authors.slice(0, 3).join(" · ") || "저자 미상"}
                            {w.authors.length > 3 ? " 외" : ""}
                          </p>
                          <div className="paper-meta">
                            <span>{w.venue || w.type}</span>
                            {seeds.includes(w.id) && (
                              <span className="seed-label">◆ seed</span>
                            )}
                            {w.evidence?.ai && (
                              <span className="green">
                                ✧ {w.evidence.ai.role}
                              </span>
                            )}
                            {w.evidence?.deferred && (
                              <span className="warning-text">
                                관련성 판단 보류
                              </span>
                            )}
                            {w.state.reading !== "unread" && (
                              <span>{READ[w.state.reading]}</span>
                            )}
                            {w.attachmentCount > 0 && (
                              <span>
                                <FileText size={11} />
                                {w.attachmentCount}
                              </span>
                            )}
                          </div>
                          {w.evidence?.hidden.length ? (
                            <div className="row-reason warning-text">
                              {w.evidence.hidden.join(" · ")}
                            </div>
                          ) : (
                            w.evidence?.reasons[0] && (
                              <div className="row-reason">
                                {w.evidence.reasons[0]}
                              </div>
                            )
                          )}
                        </button>
                        <span className="year-cell">{w.year || "—"}</span>
                        <span className="citation-cell">
                          {w.citations?.toLocaleString() ?? "—"}
                        </span>
                        <button
                          className={
                            "icon-button save-row " +
                            (w.state.screening === "included" ? "active" : "")
                          }
                          title={
                            w.state.screening === "included"
                              ? "저장됨 · 클릭해 대기함으로 이동"
                              : "아카이브에 저장"
                          }
                          onClick={() =>
                            patch([w.id], {
                              screening:
                                w.state.screening === "included"
                                  ? "pending"
                                  : "included",
                            })
                          }
                        >
                          {w.state.screening === "included" ? (
                            <Check size={17} />
                          ) : (
                            <Bookmark size={17} />
                          )}
                        </button>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <Graph
                  works={[...(list.context || []), ...list.works]}
                  edges={list.edges}
                  selected={selected}
                  seeds={seeds}
                  inspectId={inspectorId}
                  onInspect={inspect}
                  onSelection={setSelected}
                  timeline={view === "timeline"}
                  positions={positions}
                  onPositions={setPositions}
                />
              )}
            </div>
            <div className="results-footer">
              <span>
                {offset + (list.works.length ? 1 : 0)}–
                {offset + list.works.length} / {list.total}편
                {scope === "run" &&
                currentRun?.total !== null &&
                currentRun?.total !== undefined
                  ? ` · API 전체 ${currentRun.total.toLocaleString()}편`
                  : ""}
              </span>
              <div>
                {list.total > 0 && (
                  <button
                    className="text-button"
                    onClick={() =>
                      setSelected([...new Set([...selected, ...list.ids])])
                    }
                  >
                    현재 필터 결과 {list.total}편 선택
                  </button>
                )}
                {offset + list.works.length < list.total && limit < 500 && (
                  <button
                    disabled={loading || limit >= 500}
                    onClick={() => setLimit(Math.min(500, limit + 50))}
                  >
                    50편 더 표시
                  </button>
                )}
                {offset > 0 && (
                  <button
                    disabled={loading}
                    onClick={() => {
                      setList(EMPTY);
                      setOffset(Math.max(0, offset - limit));
                    }}
                  >
                    이전 페이지
                  </button>
                )}
                {limit >= 500 && offset + list.works.length < list.total && (
                  <button
                    disabled={loading}
                    onClick={() => {
                      setList(EMPTY);
                      setOffset(offset + limit);
                    }}
                  >
                    다음 500편
                  </button>
                )}
                {scope === "run" &&
                  currentRun?.tasks.some((t) => t.cursor) &&
                  !active && (
                    <button
                      onClick={() =>
                        void task(() =>
                          window.bunny.controlRun({
                            runId: scopeId,
                            action: "more",
                          }),
                        )
                      }
                    >
                      API 추가 조회
                    </button>
                  )}
              </div>
            </div>
          </main>
          {inspectorOpen && (
            <Inspector
              work={inspected}
              projectId={projectId}
              collections={snapshot.collections}
              note={
                inspected
                  ? (drafts[inspected.id]?.text ?? inspected.state.note)
                  : ""
              }
              noteStatus={
                inspected && drafts[inspected.id]
                  ? drafts[inspected.id].failed
                    ? "저장 실패 · 입력 유지"
                    : "저장 중…"
                  : "자동 저장"
              }
              onNote={(text) => {
                if (inspected)
                  setDrafts((d) => ({
                    ...d,
                    [inspected.id]: { text, projectId },
                  }));
              }}
              onPatch={(p) => {
                if (inspected) patch([inspected.id], p);
              }}
              onClose={() => setInspectorOpen(false)}
              onEdit={() => setDialog("edit")}
              onDiscover={(m, ids) => void discover(m, ids).catch(onError)}
              onError={onError}
              onInspect={inspect}
              seed={!!inspected && seeds.includes(inspected.id)}
            />
          )}
        </div>
        <footer className="statusbar">
          <span className="status-left">
            {active ? (
              <>
                <LoaderCircle size={13} className="spin" />
                {active.message}
                <button
                  onClick={() =>
                    void task(() =>
                      window.bunny.controlRun({
                        runId: active.id,
                        action: "cancel",
                      }),
                    )
                  }
                >
                  <Square size={10} />
                  취소
                </button>
              </>
            ) : currentRun ? (
              <>
                <span
                  className={
                    "status-dot " +
                    (currentRun.status === "failed" ? "error" : "")
                  }
                />
                {currentRun.message}
                {[
                  "cancelled",
                  "interrupted",
                  "failed",
                  "paused_budget",
                ].includes(currentRun.status) && (
                  <button
                    onClick={() =>
                      void task(() =>
                        window.bunny.controlRun({
                          runId: currentRun.id,
                          action: "resume",
                        }),
                      )
                    }
                  >
                    <Play size={12} />
                    재개
                  </button>
                )}
              </>
            ) : (
              <>
                <span className="status-dot" />
                로컬 라이브러리 · 저장된 문헌은 오프라인에서 이용 가능
              </>
            )}
          </span>
          <span>
            {failedNotes.length > 0 && (
              <button
                onClick={() =>
                  setDrafts((d) =>
                    Object.fromEntries(
                      Object.entries(d).map(([id, v]) => [
                        id,
                        { ...v, failed: false },
                      ]),
                    ),
                  )
                }
              >
                실패한 노트 {failedNotes.length}개 다시 저장
              </button>
            )}
            ⌘S 저장 · ⌘E 내보내기
          </span>
        </footer>
      </div>
      {toast &&
        createPortal(
          <div
            className={"toast " + (toast.error ? "error" : "")}
            role={toast.error ? "alert" : "status"}
          >
            {toast.error ? <AlertCircle size={17} /> : <Check size={17} />}
            <span>{toast.text}</span>
            <button
              className="icon-button"
              title="알림 닫기"
              onClick={() => setToast(null)}
            >
              <X size={15} />
            </button>
          </div>,
          document.querySelector("dialog[open]") || document.body,
        )}
      {dialog === "settings" && (
        <Settings
          settings={snapshot.settings}
          onClose={() => setDialog(null)}
          onSaved={refresh}
          onError={onError}
          onRestored={() => {
            initialized.current = "";
            setProjectId("");
            setScope("archive");
            setScopeId("");
            setSelected([]);
            setInspectorId(null);
            refresh();
          }}
        />
      )}
      {dialog === "import" && (
        <ImportDialog
          projectId={projectId}
          collections={snapshot.collections}
          onClose={() => setDialog(null)}
          onError={onError}
          onImported={(r) => {
            navigate("pending");
            if (r.ids[0]) inspect(r.ids[0]);
            refresh();
          }}
          onRun={openRun}
        />
      )}
      {(dialog === "manual" || dialog === "edit") && (
        <WorkEditor
          work={dialog === "edit" ? inspected || undefined : undefined}
          projectId={projectId}
          onClose={() => setDialog(null)}
          onError={onError}
          onSaved={(w) => {
            if (dialog === "manual") navigate("archive");
            inspect(w.id);
            refresh();
          }}
        />
      )}
      {dialog === "seeds" && (
        <SeedDialog
          projectId={projectId}
          selected={selected}
          profile={snapshot.seeds}
          history={snapshot.seedHistory}
          question={query || currentProject?.question || ""}
          onClose={() => setDialog(null)}
          onError={onError}
          onSaved={() => {
            refresh();
            flash("초기 관심 기준을 저장했습니다.");
          }}
        />
      )}
      {dialog === "export" && (
        <ExportDialog
          projectId={projectId}
          selected={selected}
          visibleIds={list.ids}
          collectionId={scope === "collection" ? scopeId : undefined}
          collections={snapshot.collections}
          archiveCount={snapshot.counts.archive}
          onClose={() => setDialog(null)}
          onError={onError}
          onDone={flash}
        />
      )}
      {(dialog === "project" || dialog === "collection") && (
        <Modal
          title={dialog === "project" ? "새 프로젝트" : "새 컬렉션"}
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task(async () => {
                if (dialog === "project") {
                  const p = await window.bunny.createProject({
                    name,
                    question,
                  });
                  setProjectId(p.id);
                } else await window.bunny.createCollection({ projectId, name });
                setDialog(null);
              });
            }}
          >
            <label className="field">
              이름
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            {dialog === "project" && (
              <label className="field">
                연구 질문
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows={3}
                />
              </label>
            )}
            <footer className="modal-footer">
              <button type="button" onClick={() => setDialog(null)}>
                취소
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="primary"
              >
                만들기
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {dialog === "bulk" && (
        <Modal
          title={`${selected.length}편 일괄 편집`}
          onClose={() => setDialog(null)}
        >
          <label className="field">
            컬렉션
            <select
              value={bulkCollection}
              onChange={(e) => setBulkCollection(e.target.value)}
            >
              <option value="">컬렉션 선택</option>
              {snapshot.collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!bulkCollection}
            onClick={() =>
              void task(
                () =>
                  window.bunny.collectionMembers({
                    projectId,
                    collectionId: bulkCollection,
                    ids: selected,
                  }),
                `${selected.length}편을 컬렉션에 저장했습니다.`,
              )
            }
          >
            컬렉션에 저장
          </button>
          <label className="field">
            읽기 상태
            <select
              defaultValue=""
              onChange={(e) => {
                if (e.target.value)
                  patch(selected, {
                    reading: e.target.value as LibraryState["reading"],
                  });
              }}
            >
              <option value="">일괄 변경…</option>
              {Object.entries(READ).map(([key, v]) => (
                <option value={key} key={key}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            태그 (입력한 태그로 교체)
            <input
              value={bulkTags}
              onChange={(e) => setBulkTags(e.target.value)}
            />
          </label>
          <button
            onClick={() =>
              patch(
                selected,
                {
                  tags: bulkTags
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                },
                "태그를 저장했습니다.",
              )
            }
          >
            <Tags size={14} />
            태그 적용
          </button>
          <label className="field">
            제외 이유
            <input
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
              placeholder="예: 연구 질문과 무관"
            />
          </label>
          <div className="inline-actions">
            <button
              onClick={() => {
                patch(selected, { screening: "excluded", reason: bulkReason });
                setDialog(null);
              }}
            >
              제외
            </button>
            <button onClick={() => patch(selected, { starred: true })}>
              <Star size={14} />
              핵심 표시
            </button>
            <button
              className="danger"
              onClick={() => {
                patch(
                  selected,
                  { screening: "trash" },
                  "휴지통으로 옮겼습니다.",
                );
                setDialog(null);
                setSelected([]);
              }}
            >
              <Trash2 size={14} />
              휴지통
            </button>
            {scope === "trash" && (
              <button
                onClick={() =>
                  void task(
                    () =>
                      window.bunny.restoreWorks({ projectId, ids: selected }),
                    "문헌을 복원했습니다.",
                  )
                }
              >
                휴지통에서 복원
              </button>
            )}
            {scope === "excluded" && (
              <button
                onClick={() =>
                  patch(selected, { screening: "pending", reason: "" })
                }
              >
                제외 취소
              </button>
            )}
          </div>
          <footer className="modal-footer">
            <button onClick={() => setDialog(null)}>완료</button>
          </footer>
        </Modal>
      )}
      {dialog === "history" && (
        <Modal title="탐색 이력" onClose={() => setDialog(null)} wide>
          <p className="subtle">
            조회 범위, 당시의 초기 관심 기준과 조건을 보존합니다. 부분 결과는
            전체 문헌을 뜻하지 않습니다.
          </p>
          <div className="history-list">
            {snapshot.runs.map((r) => (
              <details key={r.id} open={r.id === scopeId}>
                <summary>
                  <span>
                    {r.import ? "PDF 가져오기" : MODES[r.mode]} ·{" "}
                    {r.query || `${r.inputIds.length}편에서 시작`}
                  </span>
                  <span className="badge">{r.status}</span>
                </summary>
                <p className="subtle">
                  {new Date(r.createdAt).toLocaleString()} · 후보 {r.count}편 ·
                  API {r.calls}/{r.maxCalls}회 · {r.rankingVersion}
                  <br />
                  {r.message}
                </p>
                <p className="subtle">
                  초기 관심 버전:{" "}
                  {snapshot.seedHistory.find((s) => s.id === r.seedProfileId)
                    ?.version || "미설정"}{" "}
                  · 출발 {r.inputIds.length}편 · 관련성{" "}
                  {r.filters.relevance ? r.filters.strictness : "해제"} · 최소
                  인용 {r.filters.minCitations}
                </p>
                {!!r.ai?.plan && (
                  <p className="subtle">
                    검색 계획: {JSON.stringify(r.ai.plan)}
                  </p>
                )}
                {r.import && (
                  <ImportResults
                    runId={r.id}
                    busy={!!active}
                    onError={onError}
                    onResume={() =>
                      task(() =>
                        window.bunny.controlRun({
                          runId: r.id,
                          action: "resume",
                        }),
                      )
                    }
                  />
                )}
                <details>
                  <summary>조회·필터 상세</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        filters: r.filters,
                        tasks: r.tasks,
                        seedProfile: snapshot.seedHistory.find(
                          (s) => s.id === r.seedProfileId,
                        ),
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <div className="inline-actions">
                  <button
                    onClick={() => {
                      openRun(r);
                      setDialog(null);
                    }}
                  >
                    이 단계 열기
                  </button>
                  {!active && r.status !== "completed" && (
                    <button
                      onClick={() =>
                        void task(() =>
                          window.bunny.controlRun({
                            runId: r.id,
                            action: "resume",
                          }),
                        )
                      }
                    >
                      재개
                    </button>
                  )}
                </div>
              </details>
            ))}
          </div>
          {!snapshot.runs.length && <p>아직 탐색 기록이 없습니다.</p>}
        </Modal>
      )}
    </div>
  );
}
