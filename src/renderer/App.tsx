import { ABSTRACT_CONTEXT } from "../shared/chat";
import type { Attachment } from "../shared/types";
import { resultWindow } from "../shared/graph";
import { refreshQueue } from "../shared/refresh-queue";
import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Search,
  Plus,
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  Bookmark,
  BookmarkMinus,
  Check,
  ChevronRight,
  Compass,
  Download,
  FileText,
  Folder,
  FolderInput,
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
  LibraryBig,
  WifiOff,
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
import {
  defaultView,
  restoreNavigation,
  rememberView,
  compactNavigation,
  visitView,
  moveHistory,
  viewKey,
  runPath,
  forgetWorks,
  deselectWorks,
  deselectWhere,
  type WorkspaceView,
} from "../shared/navigation";
import { HelpTooltip } from "./components/HelpTooltip";
import { ArchiveTree } from "./components/ArchiveTree";
import { ShelfTree, shelfJobLabel } from "./components/ShelfTree";
import { SHELF_ALL, SHELF_INBOX, SHELF_REVIEW } from "../shared/shelf";
import { ResizableSidebar } from "./components/ResizableSidebar";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import type { Input } from "../shared/contracts";
import { Graph } from "./components/Graph";
import { Filters } from "./components/Filters";
import { RightPane } from "./components/RightPane";
import { ResizableInspector } from "./components/ResizableInspector";
import { Modal } from "./components/Modal";
import { DiscoveryMenu } from "./components/DiscoveryMenu";
import { GroupSelection } from "./components/GroupSelection";
import { ImportResults } from "./components/ImportResults";
import { DownloadDialog } from "./components/DownloadDialog";
import { ShelfSortDialog } from "./components/ShelfSortDialog";
import { Settings } from "./components/Settings";
import {
  ImportDialog,
  WorkEditor,
  SeedDialog,
  ExportDialog,
} from "./components/Dialogs";
const ArticleReader = lazy(() => import("./components/ArticleReader").then(module => ({ default: module.ArticleReader })));
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
// Collection ids are UUIDs, so this select value never collides with a real collection.
const NEW_COLLECTION = "new";
const EMPTY: ListResult = {
  works: [],
  total: 0,
  hidden: 0,
  deferred: 0,
  ids: [],
  edges: [],
};
type Scope = Input<"list">["scope"];
/** Views that list only papers saved to the archive. */
const ARCHIVE_SCOPES: string[] = ["archive", "topic", "unclassified"];
type Dialog =
  | "download"
  | "settings"
  | "import"
  | "manual"
  | "edit"
  | "seeds"
  | "export"
  | "collection"
  | "bulk"
  | "deleteTrash"
  | "shelfSort"
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
    // The shelf search embeds the query, so it runs on Enter instead of on every keystroke.
    [searchDraft, setSearchDraft] = useState(""),
    [sort, setSort] = useState<
      "rank" | "year" | "citations" | "title" | "updated"
    >("rank"),
    [searchSort, setSearchSort] = useState<"relevance" | "citations" | "year">(
      "relevance",
    ),
    [semantic, setSemantic] = useState(false);
  const [filters, setFilters] = useState<FilterValues>({ ...DEFAULT_FILTERS }),
    [filtersOpen, setFiltersOpen] = useState(false),
    [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);
  useEffect(() => setSearchDraft(localQuery), [localQuery]);
  const [list, setList] = useState<ListResult>(EMPTY),
    [selected, setSelected] = useState<string[]>([]),
    [inspectorId, setInspectorId] = useState<string | null>(null),
    [inspected, setInspected] = useState<WorkView | null>(null),
    [inspectorOpen, setInspectorOpen] = useState(true);
  const [view, setView] = useState<"list" | "graph" | "timeline">("list"),
    [positions, setPositions] = useState<
      Record<string, { x: number; y: number }>
    >({});
  const [reader, setReader] = useState<{ projectId: string; work: WorkView; attachmentId: string; attachments: Attachment[] } | null>(null);
  const [readerVisible, setReaderVisible] = useState(false);
  const readerRequest = useRef(0);
  const readerActive = readerVisible && reader?.projectId === projectId && reader.work.id === inspectorId;
  const chatContext = readerActive ? { kind: "pdf-fulltext" as const, attachmentId: reader.attachmentId } : ABSTRACT_CONTEXT;
  const graphView = view !== "list";
  const displayWindow = resultWindow(graphView, limit, offset);
  const [dialog, setDialog] = useState<Dialog>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [startingDiscovery, setStartingDiscovery] = useState<DiscoveryMode | null>(null),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [trashDeletion, setTrashDeletion] = useState<{
    request: Input<"deleteTrashedWorks">;
    count: number;
    /** Shelf PDFs that the deletion removes from disk. */
    shelfFiles: string[];
  } | null>(null);
  const [name, setName] = useState(""),
    [bulkReason, setBulkReason] = useState(""),
    [bulkTags, setBulkTags] = useState(""),
    [bulkCollection, setBulkCollection] = useState(""),
    [bulkCollectionName, setBulkCollectionName] = useState(""),
    [basis, setBasis] = useState<"selected" | "archive">("selected");
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; projectId: string; failed?: boolean }>
  >({});
  const initialized = useRef(""),
    noteTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({}),
    lastIndex = useRef<number | null>(null),
    searchInput = useRef<HTMLInputElement>(null),
    discoveryStarting = useRef(false),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [navigation, setNavigation] = useState(() => restoreNavigation({}));
  const [hydratedProject, setHydratedProject] = useState("");
  const navigationRef = useRef(navigation);
  const currentView: WorkspaceView = {
    scope,
    scopeId,
    selected,
    inspectorId,
    inspectorOpen,
    view,
    filters,
    networkPositions: positions,
    query,
    localQuery,
    sort,
    searchSort,
    semantic,
    filtersOpen,
    limit,
    offset,
    basis,
  };
  const viewRef = useRef(currentView);
  viewRef.current = currentView;
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const applyView = useCallback((v: WorkspaceView) => {
    readerRequest.current++;
    setReaderVisible(false);
    setReader(null);
    setList(EMPTY);
    setLoading(true);
    setInspected(null);
    setScope(v.scope);
    setScopeId(v.scopeId);
    setSelected(v.selected);
    setInspectorId(v.inspectorId);
    setInspectorOpen(v.inspectorOpen);
    setView(v.view);
    setFilters(v.filters);
    setPositions(v.networkPositions);
    setQuery(v.query);
    setLocalQuery(v.localQuery);
    setSort(v.sort);
    setSearchSort(v.searchSort);
    setSemantic(v.semantic);
    setFiltersOpen(v.filtersOpen);
    setLimit(v.limit);
    setOffset(v.offset);
    setBasis(v.basis);
    lastIndex.current = null;
    viewRef.current = v;
  }, []);
  const applyNavigation = (next: typeof navigation) => {
    navigationRef.current = next;
    setNavigation(next);
    applyView(next.views[next.keys[next.index]]);
  };
  const persistNavigation = () => {
    if (!projectId || hydratedProject !== projectId) return Promise.resolve();
    return window.bunny.saveUi({
      projectId,
      value: {
        navigation: compactNavigation(
          rememberView(navigationRef.current, viewRef.current),
        ),
      },
    });
  };
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
  const snapshotRefresh = useRef<ReturnType<typeof refreshQueue> | null>(null);
  useEffect(
    () =>
      window.bunny.onEvent((event) => {
        if (event.type === "chat") return;
        if (event.type === "service-error")
          flash(event.message || "자료 서비스 오류", true);
        // Source probes and shelf indexing progress change status, not the list or graph.
        if (event.type === "progress" || event.type === "shelf") snapshotRefresh.current?.request();
        else refresh();
      }),
    [refresh, flash],
  );
  useEffect(() => {
    let valid = true;
    let activeJob = true;
    const queue = refreshQueue(async () => {
      const data = await window.bunny.snapshot(projectId ? { projectId } : {});
      if (!valid) return;
      activeJob = data.runs.some(r => ["running", "queued"].includes(r.status)) || data.classification.job?.status === "running" || ["scanning", "indexing"].includes(data.shelf.job.state);
      setSnapshot(data);
      const current = projectId || data.projects[0].id;
      if (!projectId) {
        setProjectId(current);
        return;
      }
      document.documentElement.dataset.theme = data.settings.theme;
      if (initialized.current !== current) {
        initialized.current = current;
        const restored = restoreNavigation(data.ui);
        navigationRef.current = restored;
        setNavigation(restored);
        applyView(restored.views[restored.keys[restored.index]]);
        setHydratedProject(current);
        setList(EMPTY);
        setRevision((r) => r + 1);
      }
    }, onError);
    snapshotRefresh.current = queue;
    queue.request();
    // Recover a missed progress/completion event from the persisted job state.
    const poll = setInterval(() => { if (activeJob) queue.request(); }, 2000);
    return () => {
      valid = false;
      queue.dispose();
      clearInterval(poll);
    };
  }, [projectId, onError]);
  useEffect(() => { snapshotRefresh.current?.request(); }, [revision]);
  useEffect(() => {
    if (!projectId || initialized.current !== projectId) return;
    let valid = true;
    setLoading(true);
    const timer = setTimeout(() => {
      if ((scope === "run" || scope === "collection" || scope === "topic") && !scopeId) {
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
          showHidden: false,
          ...resultWindow(graphView, limit, offset),
          sort,
        })
        .then((result) => {
          if (valid) setList(result);
        })
        .catch((error) => {
          // A list for a project or view left since is not this view's error.
          if (valid) onError(error);
        })
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
    graphView,
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
    if (!projectId || hydratedProject !== projectId) return;
    const timer = setTimeout(
      () => void persistNavigation().catch(onError),
      350,
    );
    return () => clearTimeout(timer);
  }, [
    projectId,
    hydratedProject,
    navigation,
    scope,
    scopeId,
    selected,
    inspectorId,
    inspectorOpen,
    view,
    filters,
    positions,
    query,
    localQuery,
    sort,
    searchSort,
    semantic,
    filtersOpen,
    limit,
    offset,
    basis,
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
  const classification = snapshot?.classification;
  const classifying = classification?.job?.status === "running";
  const archiveScope = ARCHIVE_SCOPES.includes(scope);
  const active = snapshot?.runs.find(
    (r) => r.status === "running" || r.status === "queued",
  );
  const searchPending = startingDiscovery === "search" || (active?.mode === "search" && !active.import && !active.download) ||
    (scope === "run" && currentRun?.mode === "search" && loading);
  const seeds = useMemo(
    () => snapshot?.seeds?.ids || [],
    [snapshot?.seeds?.id],
  );
  const graphWorks = useMemo(
    () => [...(list.context || []), ...list.works],
    [list.context, list.works],
  );
  const graphContextIds = useMemo(
    () => (list.context || []).map((work) => work.id),
    [list.context],
  );
  // A graph scope whose papers are all unlinked still shows the graph and why it is empty.
  const graphScope = graphView && list.total > 0;
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const listedIds = useMemo(() => new Set(list.ids), [list.ids]);
  const allPageSelected = list.works.length > 0 &&
    list.works.every((work) => selectedIds.has(work.id));
  const somePageSelected = list.works.some((work) => selectedIds.has(work.id));
  const pageSelectionLabel = allPageSelected ? "이 페이지 선택 해제" : "이 페이지 전체 선택";
  // A list shows one page; 모두 선택 reaches every paper the current filters keep, on every page.
  const morePages = list.total > list.works.length;
  const allSelected = list.ids.length > 0 && list.ids.every((id) => selectedIds.has(id));
  const someSelected = list.ids.some((id) => selectedIds.has(id));
  const navigate = (
    next: Scope,
    id = "",
    fallback?: Partial<WorkspaceView>,
  ) => {
    readerRequest.current++;
    setReaderVisible(false);
    setDialog((current) => (current === "settings" ? null : current));
    const key = viewKey({ scope: next, scopeId: id });
    if (key === viewKey(viewRef.current)) return;
    const target =
      navigationRef.current.views[key] ||
      defaultView({
        scope: next,
        scopeId: id,
        query: viewRef.current.query,
        filters: {
          ...DEFAULT_FILTERS,
          relevance:
            next === "run" &&
            snapshot?.runs.find((r) => r.id === id)?.mode === "related",
          hideExcluded: next !== "excluded",
        },
        ...fallback,
      });
    applyNavigation(visitView(navigationRef.current, viewRef.current, target));
  };
  const travel = (delta: number) => {
    if (readerActive) { setReaderVisible(false); return; }
    if (dialog === "settings") {
      setDialog(null);
      return;
    }
    applyNavigation(moveHistory(navigationRef.current, viewRef.current, delta));
  };
  useEffect(() => {
    if (hydratedProject === projectId && classification && scope === "topic" &&
      !classification.topics.some(topic => topic.id === scopeId)) navigate("archive");
  }, [classification, hydratedProject, projectId, scope, scopeId]);
  const trail = scope === "run" ? runPath(snapshot?.runs || [], scopeId) : [];
  // In the shelf the list query is a ranked search, not a word filter.
  const shelfSearch = scope === "shelf" && !!localQuery.trim();
  const shelfScopeAll = (scopeId || SHELF_ALL) === SHELF_ALL;
  const inspect = (id: string) => {
    readerRequest.current++;
    setReaderVisible(false);
    setInspectorId(id);
    setInspectorOpen(true);
  };
  const openArticle = async (id: string, attachmentId?: string) => {
    inspect(id);
    const request = readerRequest.current;
    const [work, attachments] = await Promise.all([
      window.bunny.inspect({ projectId, workId: id, runId: scope === "run" ? scopeId || undefined : undefined }),
      window.bunny.attachments({ workId: id }),
    ]);
    if (request !== readerRequest.current || projectRef.current !== projectId) return;
    setInspected(work);
    const attachment = attachments.find(a => a.id === attachmentId) || attachments.find(a => a.exists) || attachments[0];
    if (attachment) { setReader({ projectId, work, attachmentId: attachment.id, attachments }); setReaderVisible(true); }
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
  // Other views remember their own selections; papers that leave a list must leave them too.
  const deselectElsewhere = (ids: string[], inTrashViews: boolean) => {
    navigationRef.current = deselectWorks(navigationRef.current, ids, inTrashViews);
    setNavigation(navigationRef.current);
  };
  const trashSelected = () => {
    if (busy || !selected.length) return;
    patch(
      selected,
      { screening: "trash" },
      `${selected.length}편을 휴지통으로 옮겼습니다. 상단 되돌리기로 복원할 수 있습니다.`,
    );
    deselectElsewhere(selected, false);
    setDialog(null);
    setSelected([]);
  };
  const restoreSelected = () => {
    if (busy || !selected.length) return;
    const ids = [...selected];
    void task(
      () => window.bunny.restoreWorks({ projectId, ids }),
      `${ids.length}편을 휴지통에서 복원했습니다.`,
    );
    deselectElsewhere(ids, true);
    setDialog(null);
    setSelected([]);
  };
  const unarchiveSelected = () => {
    if (busy || !selected.length) return;
    const ids = [...selected],
      targetProject = projectId;
    void task(async () => {
      const moved = (await window.bunny.unarchiveWorks({ projectId: targetProject, ids })).ids;
      if (projectRef.current !== targetProject) return;
      // The papers leave every archive list, so archive views stop remembering them.
      navigationRef.current = deselectWhere(navigationRef.current, moved, (view) => ARCHIVE_SCOPES.includes(view.scope));
      setNavigation(navigationRef.current);
      const left = new Set(moved);
      setSelected((current) => current.filter((id) => !left.has(id)));
      flash(moved.length
        ? `${moved.length}편을 아카이브에서 빼 검토 대기함으로 돌려보냈습니다. 상단 되돌리기로 복원할 수 있습니다.`
        : "선택한 문헌 중 아카이브에 저장된 문헌이 없습니다.");
    });
  };
  const saveToCollection = (target: string) => {
    const ids = [...selected],
      creating = target === NEW_COLLECTION,
      newName = bulkCollectionName.trim(),
      existing = snapshot?.collections.find((c) => c.id === target);
    if (busy || !ids.length || (creating ? !newName : !existing)) return;
    void task(
      async () => {
        let collectionId = target;
        if (creating) {
          collectionId = (
            await window.bunny.createCollection({ projectId, name: newName })
          ).id;
          // Point the picker at the new collection now, so a failed save retries it instead of creating a duplicate.
          setBulkCollection(collectionId);
          setBulkCollectionName("");
        }
        await window.bunny.collectionMembers({ projectId, collectionId, ids });
      },
      `'${creating ? newName : existing!.name}'에 ${ids.length}편을 저장했습니다.`,
    );
  };
  const confirmTrashDeletion = (all = false) => {
    const request: Input<"deleteTrashedWorks"> = {
      projectId,
      target: all ? { kind: "all" } : { kind: "selected", ids: [...selected] },
    };
    // The dialog names the shelf PDFs first: they leave the disk, not just this project.
    void task(async () => {
      const { count, shelfFiles } = await window.bunny.previewTrashDeletion(request);
      setTrashDeletion({ request, count, shelfFiles });
      setDialog("deleteTrash");
    });
  };
  const clearPending = () => {
    if (busy || active || classifying) return;
    const targetProject = projectId;
    void task(async () => {
      const { ids } = await window.bunny.clearPending({ projectId: targetProject });
      if (projectRef.current !== targetProject) return;
      applyNavigation(
        forgetWorks(rememberView(navigationRef.current, viewRef.current), ids),
      );
      flash(`검토 대기함 ${ids.length}편을 비웠습니다. 상단 되돌리기로 복원할 수 있습니다.`);
    });
  };
  const deleteTrash = () => {
    if (!trashDeletion || busy) return;
    void task(async () => {
      const { ids, shelf } = await window.bunny.deleteTrashedWorks(
        trashDeletion.request,
      );
      for (const id of ids) {
        clearTimeout(noteTimers.current[id]);
        delete noteTimers.current[id];
      }
      setDrafts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => !ids.includes(id)),
        ),
      );
      applyNavigation(
        forgetWorks(rememberView(navigationRef.current, viewRef.current), ids),
      );
      setDialog(null);
      setTrashDeletion(null);
      const files = shelf.deleted.length ? ` 서고 PDF ${shelf.deleted.length}개를 지웠습니다.` : "";
      if (shelf.failed.length)
        flash(`${ids.length}편을 영구 삭제했습니다.${files} 서고 PDF ${shelf.failed.length}개는 지우지 못해 그 문헌은 휴지통에 남겼습니다: ${shelf.failed[0].relPath} · ${shelf.failed[0].reason}`, true);
      else flash(`${ids.length}편을 영구 삭제했습니다.${files}`);
    });
  };
  const openRun = (run: Run, fallbackSelection: string[] = []) => {
    if (run.projectId !== projectRef.current) return;
    if (run.download || run.import?.matchExistingOnly) { setDialog("download"); return; }
    navigate("run", run.id, {
      filters: { ...run.filters },
      // An import's query is a label ("PDF 가져오기 (n개)"), not a search term.
      ...(run.import ? {} : { query: run.query }),
      selected: fallbackSelection,
    });
  };
  const discover = async (mode: DiscoveryMode, ids?: string[], shelfOnly = false) => {
    if (discoveryStarting.current || busy || active || (mode === "search" && searchPending)) return;
    if (mode === "search" && !query.trim()) return;
    discoveryStarting.current = true;
    setStartingDiscovery(mode);
    try {
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
        reading: undefined,
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
          shelfOnly,
          parentId:
            scope === "run" && !["search", "ai"].includes(mode)
              ? scopeId || undefined
              : undefined,
        });
        // Bridge the start RPC to progress snapshots so the button never goes idle
        // between accepting the request and receiving the first progress event.
        if (projectRef.current === r.projectId) {
          setSnapshot(current => current && !current.runs.some(run => run.id === r.id)
            ? { ...current, runs: [r, ...current.runs] }
            : current);
        }
        openRun(r);
      });
    } finally {
      discoveryStarting.current = false;
      setStartingDiscovery(null);
    }
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
        setDialog(null);
        if (scope !== "run") navigate("run", snapshot?.runs[0]?.id || "");
        requestAnimationFrame(() => searchInput.current?.focus());
      }
      if (editable || dialog) return;
      if (readerActive) return;
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
  }, [selected, list, dialog, projectId, scope, snapshot, readerActive]);
  const title =
    scope === "run"
      ? currentRun
        ? currentRun.import
          ? "PDF 가져오기"
          : MODES[currentRun.mode]
        : "문헌 탐색"
      : scope === "collection"
        ? snapshot?.collections.find((c) => c.id === scopeId)?.name || "컬렉션"
        : scope === "topic"
          ? classification?.topics.find(t => t.id === scopeId)?.name || "소주제"
        : scope === "shelf"
          ? scopeId === SHELF_INBOX ? "서고 수신함" : scopeId === SHELF_REVIEW ? "서고 · 확인 필요"
            : scopeId === snapshot?.shelf.uncategorized?.id ? "서고 · 미분류"
            : snapshot?.shelf.folders.find(f => f.id === scopeId)?.name || "서고"
        : {
            archive: "내 아카이브",
            unclassified: "미분류",
            pending: "검토 대기함",
            starred: "핵심 문헌",
            reading: "읽기 목록",
            trash: "휴지통",
            excluded: "제외 문헌",
          }[scope as string] || "문헌";
  const fullPage = dialog === "settings";
  const pinnedIds = new Set([...(list.context || []), ...(list.shelf || [])].map((w) => w.id));
  const hiddenSelected = selected.filter(
    (id) => !listedIds.has(id) && !pinnedIds.has(id),
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
  const explorationRuns = snapshot.runs.filter(run => !run.download && !run.import?.matchExistingOnly);
  // A collection picked in another project is not offered here, so fall back to the placeholder.
  const bulkTarget =
    bulkCollection === NEW_COLLECTION ||
    snapshot.collections.some((c) => c.id === bulkCollection)
      ? bulkCollection
      : "";
  const bulkCreating = bulkTarget === NEW_COLLECTION;
  return (
    <div
      className="app-shell"
      style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
    >
      <ResizableSidebar>
        <div className="drag-region electrobun-webkit-app-region-drag" />
        <div className="brand">
          <Bunny />
          <strong>ResearchBunny</strong>
        </div>
        <ProjectSwitcher projects={snapshot.projects} projectId={projectId}
          onSelect={async id => {
            await persistNavigation();
            setProjectId(id);
          }}
          onCreate={async (name, question) => {
            await persistNavigation();
            const project = await window.bunny.createProject({ name, question });
            setSnapshot(current => current && ({ ...current, projects: [project, ...current.projects.filter(p => p.id !== project.id)] }));
            setProjectId(project.id);
            flash("새 프로젝트를 만들었습니다.");
          }}
          onManage={() => {
            setDialog("settings");
            requestAnimationFrame(() => document.getElementById("settings-projects")?.scrollIntoView());
          }} />
        <nav>
          <button
            className={!fullPage && scope === "run" ? "active" : ""}
            onClick={() => navigate("run", explorationRuns[0]?.id || "")}
          >
            <Compass size={17} />
            문헌 탐색
          </button>
          <ShelfTree
            shelf={snapshot.shelf}
            scope={fullPage ? "" : scope}
            scopeId={scopeId}
            navigate={navigate}
            onSetup={() => {
              setDialog("settings");
              requestAnimationFrame(() => document.getElementById("settings-shelf")?.scrollIntoView());
            }}
          />
          <div className="nav-label">라이브러리</div>
          <ArchiveTree
            key={projectId}
            classification={snapshot.classification}
            count={snapshot.counts.archive || 0}
            scope={fullPage ? "" : scope}
            scopeId={scopeId}
            navigate={navigate}
          />
          {(
            [
              { key: "pending", label: "검토 대기함", icon: Inbox },
              { key: "starred", label: "핵심 문헌", icon: Star },
              { key: "reading", label: "읽기 목록", icon: Bookmark },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              className={!fullPage && scope === key ? "active" : ""}
              data-help={
                {
                  pending: "이번 탐색에서 검토할 임시 문헌입니다. 새 검색을 시작하면 비워집니다.",
                  starred: "중요하다고 별표 표시한 문헌입니다.",
                  reading: "읽기 상태를 지정한 문헌을 모아 봅니다.",
                }[key]
              }
              onClick={() => navigate(key)}
            >
              <Icon size={17} />
              {label}
              <span className="nav-count">{snapshot.counts[key] || 0}</span>
            </button>
          ))}
          <details className="manual-collections">
          <summary>수동 컬렉션 <span className="nav-count">{snapshot.collections.length}</span></summary>
          <div className="manual-collection-items">
            <button
              className="new-collection"
              title="새 컬렉션"
              onClick={() => {
                setName("");
                setDialog("collection");
              }}
            >
              <Plus size={14} />
              새 컬렉션
            </button>
          {snapshot.collections.length ? (
            snapshot.collections.map((c) => (
              <button
                key={c.id}
                className={
                  !fullPage && scope === "collection" && scopeId === c.id
                    ? "active"
                    : ""
                }
                data-help={`${c.name}에 모아 둔 문헌을 봅니다.`}
                onClick={() => navigate("collection", c.id)}
              >
                <Folder size={16} />
                <span className="ellipsis">{c.name}</span>
                <span className="nav-count">{c.count}</span>
              </button>
            ))
          ) : null}
          </div>
          </details>
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setDialog("import")}>
            <Upload size={16} />
            문헌 가져오기
          </button>
          <button
            data-help="제외한 문헌과 이유를 확인하고 다시 포함할 수 있습니다."
            onClick={() => navigate("excluded")}
          >
            <Archive size={15} />
            제외 문헌
            <span className="nav-count">{snapshot.counts.excluded}</span>
          </button>
          <button
            data-help="삭제한 문헌을 확인하고 복원합니다."
            onClick={() => navigate("trash")}
          >
            <Trash2 size={15} />
            휴지통<span className="nav-count">{snapshot.counts.trash}</span>
          </button>
          <button
            className={dialog === "settings" ? "active" : ""}
            onClick={() => setDialog("settings")}
          >
            <SettingsIcon size={16} />
            설정
            <span className="local-dot" />
            로컬
          </button>
        </div>
      </ResizableSidebar>
      <div className="main-shell">
        <header className="topbar">
          <div className="navigation-buttons" aria-label="화면 이동">
            <button
              aria-label="이전 단계"
              data-help="이전 화면의 선택 문헌과 필터를 복원합니다. 저장한 자료는 바뀌지 않습니다."
              disabled={(!readerActive && !fullPage && navigation.index === 0) || busy}
              onClick={() => travel(-1)}
            >
              <ArrowLeft size={17} />
            </button>
            <button
              aria-label="다음 단계"
              data-help="뒤로 이동하기 전의 화면으로 다시 갑니다."
              disabled={
                fullPage ||
                navigation.index >= navigation.keys.length - 1 ||
                busy
              }
              onClick={() => travel(1)}
            >
              <ArrowRight size={17} />
            </button>
          </div>
          {!fullPage && scope === "run" ? (
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
                  placeholder="연구 주제, 제목, DOI, PMID로 논문 찾기"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>⌘ K</kbd>
                <button
                  className="primary"
                  disabled={busy || startingDiscovery !== null || !!active || searchPending || !query.trim()}
                  aria-busy={searchPending}
                  type="submit"
                >
                  {searchPending ? "검색 중…" : "검색"}
                  {searchPending ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
                </button>
              </form>
              <details className="search-options-menu">
                <summary aria-label="검색 옵션">
                  <SlidersHorizontal size={16} />
                </summary>
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
                  {snapshot.shelf.configured && (
                    <button
                      disabled={busy || !!active || !query.trim()}
                      data-help="네트워크 없이 서고에서만 찾습니다. 한국어 질의도 됩니다."
                      onClick={() => void discover("search", undefined, true).catch(onError)}
                    >
                      <LibraryBig size={15} />
                      서고만 검색
                    </button>
                  )}
                  <span className="search-provider">
                    {snapshot.shelf.configured ? "내 서고 → " : ""}OpenAlex
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
                        (snapshot.settings.aiProvider === "openai" && !snapshot.settings.openaiConfigured)
                      ) {
                        setDialog("settings");
                        flash(
                          "설정에서 AI 연결을 선택하고 AI 추천을 켜 주세요.",
                        );
                      } else void discover("ai").catch(onError);
                    }}
                  >
                    <Sparkles size={15} />
                    핵심 논문 찾기<span className="badge">실험</span>
                  </button>
                </div>
              </details>
            </div>
          ) : (
            <div className="breadcrumb">
              <span className="breadcrumb-project" title={currentProject?.name}>{currentProject?.name}</span>
              <ChevronRight size={13} />
              <strong>{dialog === "settings" ? "설정" : title}</strong>
            </div>
          )}
          <div className="topbar-actions" hidden={fullPage}>
            {scope !== "run" && (
              <button onClick={() => setDialog("import")}>
                <Upload size={15} />
                문헌 가져오기
              </button>
            )}
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
        {dialog === "settings" && (
          <Settings
            settings={snapshot.settings}
            onClose={() => setDialog(null)}
            onSaved={refresh}
            onError={onError}
            onRestored={() => {
              initialized.current = "";
              setHydratedProject("");
              setProjectId("");
              setScope("archive");
              setScopeId("");
              setSelected([]);
              setInspectorId(null);
              refresh();
            }}
            projects={snapshot.projects}
            projectId={projectId}
            onRenameProject={async (id, name) => {
              const project = await window.bunny.updateProject({ projectId: id, name });
              setSnapshot(current => current && ({ ...current, projects: current.projects.map(p => p.id === id ? project : p) }));
            }}
            onDeleteProject={async (id) => {
              const deleted = snapshot.projects.find(p => p.id === id);
              const next = snapshot.projects.find(p => p.id !== id);
              const leaving = id === projectId && !!next;
              if (leaving) {
                // Leave the project first, so nothing reads or saves it once it is gone.
                await persistNavigation();
                setProjectId(next.id);
              }
              try {
                await window.bunny.deleteProject({ projectId: id });
              } catch (error) {
                // Nothing was deleted: go back to the project.
                if (leaving) setProjectId(id);
                throw error;
              }
              setSnapshot(current => current && ({ ...current, projects: current.projects.filter(p => p.id !== id) }));
              flash(`‘${deleted?.name}’ 프로젝트를 삭제했습니다.`);
            }}
          />
        )}
        {!fullPage && (
          <>
            <div className="seed-strip" hidden={!seeds.length}>
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
              <button
                className="text-button"
                onClick={() => setDialog("seeds")}
              >
                {seeds.length ? "기준 변경" : "seed 지정"}
                <ChevronRight size={13} />
              </button>
            </div>
            <div className="article-modebar" aria-label="탐색과 원문 전환">
              <div className="article-mode-switch">
                <button aria-pressed={!readerActive} onClick={() => setReaderVisible(false)}><List size={15} />탐색</button>
                <button aria-pressed={!!readerActive} disabled={!inspected?.attachmentCount} onClick={() => {
                  if (reader?.projectId === projectId && reader.work.id === inspectorId) setReaderVisible(true);
                  else if (inspectorId) void openArticle(inspectorId).catch(onError);
                }}><FileText size={15} />원문 보기</button>
              </div>
              {readerActive && reader.attachments.length > 1 ? <select aria-label="원문 PDF 선택" value={reader.attachmentId} onChange={e => setReader({ ...reader, attachmentId: e.target.value })}>{reader.attachments.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select> : <span>{readerActive ? "PDF 본문 대화 · 탐색 대화와 별도 보관" : "논문을 선택해 초록을 확인하고 첨부 원문을 읽어보세요"}</span>}
            </div>
            <div
              className={
                "workspace " +
                (scope === "run" ? "discovery-workspace" : "library-workspace")
              }
            >
              <main className="workspace-main" hidden={!!readerActive}>
                <div className="workspace-heading">
                  <div>
                    {scope === "topic" || scope === "unclassified" ? (
                      <button className="text-button archive-breadcrumb" onClick={() => navigate("archive")}>내 아카이브 <ChevronRight size={13} /></button>
                    ) : scope === "shelf" && scopeId !== SHELF_ALL ? (
                      <button className="text-button archive-breadcrumb" onClick={() => navigate("shelf", SHELF_ALL)}>서고 <ChevronRight size={13} /></button>
                    ) : <div className="eyebrow">{scope === "run" ? "DISCOVER" : scope === "shelf" ? "SHELF" : "LIBRARY"}</div>}
                    <h1>
                      {title}
                      <span>{(list.total + (list.shelf?.length || 0)).toLocaleString()}</span>
                    </h1>
                  </div>
                  <div className="workspace-actions">
                  {(archiveScope || scope === "collection") && <button className="secondary" onClick={() => setDialog("download")} disabled={!snapshot.counts.archive}>
                    <Download size={15} /> PDF 원문 찾기
                  </button>}
                  {archiveScope && <button className="secondary" disabled={busy || !!active || classifying || !snapshot.counts.archive}
                    onClick={() => {
                      if (!snapshot.settings.aiEnabled) { setDialog("settings"); return; }
                      void task(async () => {
                        const job = await window.bunny.classifyArchive({ projectId });
                        if (projectRef.current === projectId)
                          setSnapshot(current => current && ({ ...current, classification: { ...current.classification, job } }));
                      });
                    }}>
                    {classifying ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                    {classifying ? "분류 중" : classification?.topics.length ? `분류 갱신${classification.unclassified ? ` · 미분류 ${classification.unclassified}편` : ""}` : "분류"}
                  </button>}
                  {scope === "shelf" && (scopeId === SHELF_INBOX || scopeId === snapshot.shelf.uncategorized?.id) && <button className="secondary" disabled={!snapshot.shelf.online}
                    data-help="비슷한 서고 논문의 폴더(로컬 임베딩)와 AI 판정으로 수신함 PDF가 갈 폴더를 제안합니다. 미분류 목록에서 열면 미분류 PDF도 다시 판정합니다. 확인하고 승인한 PDF만 옮깁니다."
                    onClick={() => setDialog("shelfSort")}>
                    <FolderInput size={15} /> 수신함 정리
                  </button>}
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
                </div>
                {scope === "shelf" && (!snapshot.shelf.online || snapshot.shelf.job.state !== "idle" || snapshot.shelf.job.message) && <div className={`classification-status shelf-job ${!snapshot.shelf.online ? "failed" : ""}`} role="status">
                  <span>{!snapshot.shelf.online && <WifiOff size={13} />} {snapshot.shelf.job.message || shelfJobLabel(snapshot.shelf)}{!snapshot.shelf.online ? " · PDF 열기만 NAS 연결이 필요합니다." : ""}</span>
                  {snapshot.shelf.job.state === "confirm" && <button className="text-button" onClick={() => void task(() => window.bunny.shelfControl({ action: "confirmMissing" }))}>사라진 파일 반영</button>}
                  {["indexing", "scanning"].includes(snapshot.shelf.job.state) && <button className="icon-button" title="서고 색인 일시정지" aria-label="서고 색인 일시정지" onClick={() => void task(() => window.bunny.shelfControl({ action: "pause" }))}><Square size={14} /></button>}
                  {snapshot.shelf.job.state === "paused" && <button className="text-button" onClick={() => void task(() => window.bunny.shelfControl({ action: "resume" }))}><Play size={12} />재개</button>}
                </div>}
                {archiveScope && classification?.job && <div className={`classification-status ${classification.job.status}`} role="status">
                  <span>{classification.job.message}</span>
                  {classifying && <button className="icon-button" title="자동 분류 취소" aria-label="자동 분류 취소" onClick={() => void task(() => window.bunny.cancelClassification({ projectId }))}><Square size={14} /></button>}
                </div>}
                {scope === "run" && currentRun && (
                  <div className="run-context">
                    <div className="run-wayfinding">
                      <nav className="run-trail" aria-label="탐색 경로">
                        {trail.map((r, index) => (
                          <span key={r.id}>
                            {index > 0 && (
                              <ChevronRight size={12} aria-hidden="true" />
                            )}
                            <button
                              aria-current={
                                r.id === scopeId ? "step" : undefined
                              }
                              disabled={busy}
                              data-help={
                                r.id === scopeId
                                  ? `현재 단계입니다. ${r.query || "선택 문헌에서 탐색"}`
                                  : `이 단계의 선택과 필터로 돌아갑니다. ${r.query || ""}`
                              }
                              onClick={() =>
                                openRun(r, trail[index + 1]?.inputIds)
                              }
                            >
                              {index + 1}.{" "}
                              {r.import ? "PDF 가져오기" : MODES[r.mode]}
                            </button>
                          </span>
                        ))}
                      </nav>
                      <span className="run-origin">
                        현재 {trail.length}단계 ·{" "}
                        {currentRun.inputIds.length
                          ? `출발 문헌 ${currentRun.inputIds.length}편`
                          : currentRun.query || "문헌 탐색"}
                      </span>
                    </div>
                  </div>
                )}
                {scope === "run" && currentRun?.import && (
                  <div className="run-import-results">
                    <ImportResults
                      runId={currentRun.id}
                      refreshKey={currentRun.updatedAt}
                      busy={busy || !!active}
                      onError={onError}
                      onResume={() =>
                        task(() =>
                          window.bunny.controlRun({
                            runId: currentRun.id,
                            action: "resume",
                          }),
                        )
                      }
                    />
                  </div>
                )}
                <div className="selection-bar">
                  <label>
                    <input
                      type="checkbox"
                      checked={
                        list.works.length > 0 &&
                        list.works.every((w) => selectedIds.has(w.id))
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
                    <strong className={selected.length ? "selection-count active" : "selection-count"}>
                      {selected.length
                        ? `${selected.length}편 선택됨`
                        : seeds.length
                          ? `초기 관심 ${seeds.length}편`
                          : "문헌 선택"}
                    </strong>
                    {hiddenSelected > 0 && (
                      <span>({hiddenSelected}편 숨김)</span>
                    )}
                  </label>
                  <DiscoveryMenu
                    disabled={busy || !!active}
                    canDiscover={!!(selected.length || seeds.length)}
                    onDiscover={(mode, shelfOnly) => void discover(mode, undefined, shelfOnly).catch(onError)}
                    basis={basis}
                    onBasis={setBasis}
                    shelf={snapshot.shelf.configured}
                  />
                  {archiveScope ? (
                    <button
                      disabled={busy || !selected.length}
                      data-help="선택한 문헌을 아카이브에서 빼 검토 대기함으로 돌려보냅니다. 논문·PDF·메모는 그대로이고 상단 되돌리기로 복원할 수 있습니다."
                      onClick={unarchiveSelected}
                    >
                      <BookmarkMinus size={14} />
                      아카이브에서 빼기
                    </button>
                  ) : (
                    <button
                      disabled={!selected.length}
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
                  )}
                  <button onClick={() => setDialog("seeds")}>
                    <Leaf size={14} />
                    seed
                  </button>
                  <button onClick={() => setDialog("export")}>
                    <Download size={14} />
                    내보내기
                  </button>
                  {scope !== "trash" && (
                    <button
                      className="danger"
                      disabled={busy || !selected.length}
                      onClick={trashSelected}
                    >
                      <Trash2 size={14} />
                      휴지통
                    </button>
                  )}
                  <button title="일괄 편집" onClick={() => setDialog("bulk")}>
                    <MoreHorizontal size={17} />
                  </button>
                  {scope === "pending" && (
                    <button
                      disabled={busy || !!active || !!classifying || !snapshot.counts.pending}
                      data-help="검색·필터와 관계없이 검토 대기함 전체를 비웁니다. 논문·PDF·메모·탐색 이력은 보존되며 상단 되돌리기로 복원할 수 있습니다."
                      onClick={clearPending}
                    >
                      <Inbox size={14} />
                      검토 대기함 비우기
                    </button>
                  )}
                  {scope === "trash" && (
                    <>
                      <button
                        className="danger"
                        disabled={busy || !!active || !selected.length}
                        onClick={() => confirmTrashDeletion()}
                      >
                        <Trash2 size={14} />
                        선택 영구 삭제
                      </button>
                      <button
                        className="danger"
                        disabled={busy || !!active || !snapshot.counts.trash}
                        onClick={() => confirmTrashDeletion(true)}
                      >
                        휴지통 비우기
                      </button>
                    </>
                  )}
                </div>
                <div className="list-toolbar">
                  {scope === "shelf" ? (
                    <form
                      className="local-search shelf-search"
                      role="search"
                      onSubmit={(e) => {
                        e.preventDefault();
                        // Read the field itself: Enter can commit a Hangul syllable in the same keystroke.
                        const field = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
                        setLocalQuery(field.value.trim());
                        setOffset(0);
                      }}
                    >
                      <span className="shelf-search-icon" data-help="제목·초록의 의미가 가까운 논문을 관련도순으로 보여 줍니다. 한국어 질의도 됩니다. 단어가 들어 있는지로 거르려면 필터의 포함어를 쓰세요.">
                        {loading && shelfSearch ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
                      </span>
                      <input
                        name="q"
                        aria-label="서고에서 의미로 검색"
                        placeholder={shelfScopeAll ? "서고 전체에서 주제·질문으로 검색" : "이 폴더에서 주제·질문으로 검색"}
                        value={searchDraft}
                        onChange={(e) => setSearchDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape" && (searchDraft || localQuery)) {
                            e.preventDefault();
                            setLocalQuery("");
                            setSearchDraft("");
                          }
                        }}
                      />
                      {searchDraft.trim() && searchDraft.trim() !== localQuery.trim() && (
                        <button type="submit" className="shelf-search-submit" aria-label="서고 검색 실행">검색</button>
                      )}
                      {(searchDraft || localQuery) && (
                        <button type="button" className="icon-button" title="검색 지우기" aria-label="검색 지우기"
                          onClick={() => { setLocalQuery(""); setSearchDraft(""); }}>
                          <X size={13} />
                        </button>
                      )}
                    </form>
                  ) : (
                    <div className="local-search">
                      <Search size={14} />
                      <input
                        aria-label="현재 문헌에서 찾기"
                        placeholder={
                          scope === "run"
                            ? "결과 내 검색"
                            : scope === "collection"
                              ? "컬렉션에서 찾기"
                              : "아카이브에서 찾기"
                        }
                        value={localQuery}
                        onChange={(e) => setLocalQuery(e.target.value)}
                      />
                    </div>
                  )}
                  {scope !== "run" && (
                    <div
                      className="reading-filter"
                      role="group"
                      aria-label="읽기 상태 필터"
                    >
                      {(
                        [
                          [undefined, "전체"],
                          ["planned", "읽을 예정"],
                          ["reading", "읽는 중"],
                          ["read", "읽음"],
                        ] as const
                      ).map(([reading, label]) => (
                        <button
                          key={label}
                          aria-pressed={filters.reading === reading}
                          onClick={() => setFilters({ ...filters, reading })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
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
                    {/* A run's own order is its relevance rank, so it says so. */}
                    <option value="rank">{shelfSearch || scope === "run" ? "관련도순" : "기본 순서"}</option>
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
                {shelfSearch && (
                  <div className="shelf-search-status" role="status">
                    <span>
                      {loading
                        ? "서고에서 찾는 중…"
                        : `‘${localQuery.trim()}’ 관련 ${list.total.toLocaleString()}편${sort === "rank" ? " · 관련도순" : ""}`}
                      {!loading && list.search && !list.search.semantic && !list.search.identifier &&
                        " · Ollama를 쓸 수 없어 검색어가 들어 있는 논문만 찾았습니다."}
                    </span>
                    <span className="shelf-search-actions">
                      {!shelfScopeAll && (
                        <button className="text-button" onClick={() => {
                          const q = localQuery;
                          navigate("shelf", SHELF_ALL);
                          setLocalQuery(q);
                          setOffset(0);
                        }}>
                          서고 전체에서 찾기
                        </button>
                      )}
                      <button className="text-button" onClick={() => { setLocalQuery(""); setSearchDraft(""); }}>
                        검색 지우기
                      </button>
                    </span>
                  </div>
                )}
                {filtersOpen && (
                  <Filters value={filters} onChange={setFilters} />
                )}
                {list.hidden > 0 && (
                  <div className="hidden-banner">
                    <span>
                      필터로 제외된 문헌 {list.hidden}편
                      {list.deferred
                        ? ` · 관련성 판단 보류 ${list.deferred}편`
                        : ""}
                    </span>
                  </div>
                )}
                {scope === "run" && !!list.context?.length && (
                  <details className="graph-context">
                    <summary>
                      출발·초기 기준 문헌 {list.context.length}편 · 후보 집계와
                      별도 표시
                    </summary>
                    <GroupSelection ids={list.context.map((w) => w.id)} selected={selectedIds} setSelected={setSelected} />
                    <div>
                      {list.context.map((w) => (
                        <label key={w.id}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(w.id)}
                            onChange={(e) =>
                              setSelected((ids) =>
                                e.target.checked
                                  ? [...new Set([...ids, w.id])]
                                  : ids.filter((id) => id !== w.id),
                              )
                            }
                          />
                          <button onClick={() => inspect(w.id)}>
                            {w.title}
                          </button>
                        </label>
                      ))}
                    </div>
                  </details>
                )}
                {scope === "run" && !!list.shelf?.length && (
                  <details className="shelf-pinned" open>
                    <summary><LibraryBig size={15} />내 서고에서 찾음 {list.shelf.length}편 <span className="subtle">· 이미 가진 PDF · 다운로드 불필요</span></summary>
                    <GroupSelection ids={list.shelf.map((w) => w.id)} selected={selectedIds} setSelected={setSelected} />
                    <div>
                      {list.shelf.map((w) => (
                        <div key={w.id} className={`shelf-pinned-row ${inspectorId === w.id ? "inspected" : ""}`}>
                          <input type="checkbox" aria-label={`${w.title} 선택`} checked={selectedIds.has(w.id)}
                            onChange={(e) => setSelected((ids) => e.target.checked ? [...new Set([...ids, w.id])] : ids.filter((id) => id !== w.id))} />
                          <button onClick={() => inspect(w.id)}>
                            <strong>{w.title}</strong>
                            <span>{w.authors.slice(0, 2).join(" · ") || "저자 미상"}{w.authors.length > 2 ? " 외" : ""} · {w.year || "연도 미상"}</span>
                          </button>
                          <span className="folder-chip" title={w.shelf?.path}>{w.evidence?.shelf?.folder?.split("/").pop() || w.shelf?.folder.split("/").pop() || "수신함"}</span>
                          <span className="pinned-origins">{w.evidence?.origins.filter((o) => !o.startsWith("내 서고")).length ? "외부 검색에도 있음" : ""}</span>
                          {w.attachmentCount > 0 && (
                            <button className="icon-button read-row" aria-label={`${w.title} 원문 보기`} title="원문 보기" onClick={() => void openArticle(w.id).catch(onError)}>
                              <FileText size={14} />
                            </button>
                          )}
                        </div>
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
                  ) : !list.works.length && !graphScope && list.shelf?.length ? (
                    <p className="subtle shelf-only-note">
                      {currentRun?.rankingVersion === "shelf-v1" ? "서고에서만 찾았습니다. 외부 검색은 검색 버튼으로 실행하세요." : "서고 밖 검색 결과가 없거나 필터로 숨겨졌습니다."}
                    </p>
                  ) : !list.works.length && !graphScope ? (
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
                          : shelfSearch
                            ? `‘${localQuery.trim()}’ 관련 논문을 찾지 못했습니다.`
                          : scope === "archive"
                            ? "첫 문헌부터 시작하세요."
                            : scope === "shelf"
                            ? snapshot.shelf.configured ? "이 폴더에 색인된 논문이 없습니다." : "서고를 연결하세요."
                          : scope === "pending"
                              ? "검토를 기다리는 문헌이 없습니다."
                              : scope === "run"
                                ? "연구의 출발점을 찾아보세요."
                                : `아직 ${title}이 없습니다.`}
                      </h2>
                      <p>
                        {list.hidden
                          ? "필터 조건을 완화하거나 초기화해 주세요."
                          : shelfSearch
                            ? "다른 표현으로 찾거나 서고 전체에서 검색해 보세요."
                          : "주제나 DOI로 검색하고 관심 논문을 골라보세요. 기존 BibTeX와 PDF로도 시작할 수 있습니다."}
                      </p>
                      <div className="inline-actions">
                        <button
                          className="primary"
                          onClick={() => {
                            navigate("run", explorationRuns[0]?.id || "");
                            requestAnimationFrame(() =>
                              searchInput.current?.focus(),
                            );
                          }}
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
                          id="page-selection"
                          aria-label={pageSelectionLabel}
                          type="checkbox"
                          checked={allPageSelected}
                          ref={input => {
                            if (input) input.indeterminate = somePageSelected && !allPageSelected;
                          }}
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
                                    (id) =>
                                      !list.works.some((w) => w.id === id),
                                  ),
                            )
                          }
                        />
                        <div className="selection-scopes">
                          <label className="page-selection-label" htmlFor="page-selection">
                            {pageSelectionLabel}
                          </label>
                          {morePages && (
                            <label className="page-selection-label all-selection">
                              <input
                                type="checkbox"
                                checked={allSelected}
                                ref={input => {
                                  if (input) input.indeterminate = someSelected && !allSelected;
                                }}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? [...new Set([...selected, ...list.ids])]
                                      : selected.filter((id) => !listedIds.has(id)),
                                  )
                                }
                              />
                              {allSelected ? "모두 선택 해제" : `모두 선택 · ${list.total.toLocaleString()}편`}
                            </label>
                          )}
                        </div>
                        <span>연도</span>
                        <span>{scope === "run" ? "인용" : "읽기 상태"}</span>
                        <span />
                      </div>
                      <div className="paper-list">
                        {list.works.map((w, index) => (
                          <article
                            key={w.id}
                            className={
                              "paper-row " +
                              (selectedIds.has(w.id) ? "selected " : "") +
                              (inspectorId === w.id ? "inspected " : "") +
                              (w.evidence?.hidden.length ? "filtered" : "")
                            }
                          >
                            <input
                              type="checkbox"
                              aria-label={`${w.title} 선택`}
                              checked={selectedIds.has(w.id)}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(w.id, index, e.shiftKey);
                              }}
                              onChange={() => {}}
                            />
                            <button
                              className="paper-main"
                              title="문헌 선택"
                              // Browsing shows the record only; the PDF loads on 원문 보기.
                              onClick={() => inspect(w.id)}
                            >
                              <h3>{w.title}</h3>
                              <p>
                                {w.authors.slice(0, 3).join(" · ") ||
                                  "저자 미상"}
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
                                {w.shelf && scope !== "shelf" && (
                                  <span className={`shelf-badge ${w.shelf.match === "title" ? "hint" : ""}`} title={w.shelf.path}>
                                    <LibraryBig size={11} />
                                    {w.shelf.match === "title" ? "서고에 같은 제목" : `서고 · ${w.shelf.folder.split("/").pop()}`}
                                  </span>
                                )}
                                {scope === "shelf" && w.shelf && ["review", "provisional"].includes(w.shelf.status) && (
                                  w.shelf.stage === "resolved"
                                    ? <span className="warning-text">확인 필요</span>
                                    : <span className="subtle">서지 확인 대기</span>
                                )}
                                {scope === "shelf" && !w.abstract && <span className="subtle">초록 없음</span>}
                                {scope === "shelf" && w.abstract && w.raw?.abstractSource === "pdf" && <span className="subtle">PDF에서 추출한 초록</span>}
                                {scope === "shelf" && w.state.screening === "included" && <span className="green">이 프로젝트에 저장됨</span>}
                                {scope === "shelf" && scopeId !== w.shelf?.folderId && w.shelf && !(scopeId === SHELF_INBOX && w.shelf.folder === "수신함") && (
                                  <span className="folder-chip">{w.shelf.folder.split("/").pop()}</span>
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
                              {scope === "run"
                                ? (w.citations?.toLocaleString() ?? "—")
                                : READ[w.state.reading]}
                            </span>
                            <div className="row-actions">
                              <button
                                className={
                                  "icon-button save-row " +
                                  (w.state.screening === "included"
                                    ? "active"
                                    : "")
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
                              {w.attachmentCount > 0 && (
                                <button
                                  className="icon-button read-row"
                                  aria-label={`${w.title} 원문 보기`}
                                  title="원문 보기"
                                  onClick={() => void openArticle(w.id).catch(onError)}
                                >
                                  <FileText size={15} />
                                </button>
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : (
                    <Graph
                      works={graphWorks}
                      topics={snapshot.classification.topics}
                      subfolders={list.subfolders}
                      resultTotal={list.total}
                      connected={list.graph?.connected}
                      contextIds={graphContextIds}
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
                    {graphView
                      ? `연결된 ${list.works.length.toLocaleString()}편 / ${list.total.toLocaleString()}편`
                      : `${displayWindow.offset + (list.works.length ? 1 : 0)}–${displayWindow.offset + list.works.length} / ${list.total}편`}
                    {scope === "run" &&
                    currentRun?.total !== null &&
                    currentRun?.total !== undefined
                      ? ` · API 전체 ${currentRun.total.toLocaleString()}편`
                      : ""}
                  </span>
                  <div>
                    {/* The list heading has its own 모두 선택; a graph has no heading. */}
                    {graphView && list.total > 0 && (
                      <button
                        className="text-button"
                        onClick={() =>
                          setSelected([...new Set([...selected, ...list.ids])])
                        }
                      >
                        현재 필터 결과 {list.total}편 선택
                      </button>
                    )}
                    {!graphView && offset + list.works.length < list.total && limit < 500 && (
                      <button
                        disabled={loading || limit >= 500}
                        onClick={() => setLimit(Math.min(500, limit + 50))}
                      >
                        50편 더 표시
                      </button>
                    )}
                    {!graphView && offset > 0 && (
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
                    {!graphView && limit >= 500 &&
                      offset + list.works.length < list.total && (
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
                      currentRun?.tasks.some((t) => t.cursor ||
                        (snapshot.settings.linkedDiscoveries && t.kind === "linked" && (t.size || 20) < 200)) &&
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
              {reader?.projectId === projectId && <Suspense fallback={<div className="reader-loading">원문 뷰어 준비 중…</div>}><ArticleReader key={`${projectId}:${reader.attachmentId}`} projectId={projectId} work={reader.work} attachmentId={reader.attachmentId} visible={!!readerActive} onBrowse={() => setReaderVisible(false)} /></Suspense>}
              {inspectorOpen && (
                <ResizableInspector>
                <RightPane
                  context={chatContext}
                  onReadPdf={attachmentId => { if (inspectorId) void openArticle(inspectorId, attachmentId).catch(onError); }}
                  settings={snapshot.settings}
                  onSettings={() => setDialog("settings")}
                  work={inspected?.id === inspectorId ? inspected : null}
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
                  shelfConfigured={snapshot.shelf.configured}
                  seed={!!inspected && seeds.includes(inspected.id)}
                />
                </ResizableInspector>
              )}
            </div>
          </>
        )}
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
            ) : ["scanning", "indexing"].includes(snapshot.shelf.job.state) ? (
              <>
                <LoaderCircle size={13} className="spin" />
                {snapshot.shelf.job.message}
                {snapshot.shelf.job.total ? ` · ${(snapshot.shelf.job.done || 0).toLocaleString()}/${snapshot.shelf.job.total.toLocaleString()}` : ""}
              </>
            ) : (
              <>
                <span className="status-dot" />
                로컬 라이브러리 · 저장된 문헌은 오프라인에서 이용 가능
              </>
            )}
          </span>
          {!fullPage && (
            <span className={`status-selection${selected.length ? " active" : ""}`} role="status" aria-live="polite" aria-atomic="true">
              선택한 논문 {selected.length}편
              {hiddenSelected > 0 && ` · 현재 목록 밖 ${hiddenSelected}편 포함`}
            </span>
          )}
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
      <HelpTooltip />
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
      {dialog === "import" && (
        <ImportDialog
          projectId={projectId}
          collections={snapshot.collections}
          shelf={snapshot.shelf.configured}
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
      {dialog === "shelfSort" && <ShelfSortDialog aiEnabled={snapshot.settings.aiEnabled}
        uncategorized={scope === "shelf" && scopeId === snapshot.shelf.uncategorized?.id}
        onClose={() => setDialog(null)} onError={onError} onSettings={() => setDialog("settings")} />}
      {dialog === "download" && <DownloadDialog key={projectId} projectId={projectId} selected={selected} scope={scope} scopeId={scopeId}
        runs={snapshot.runs} busy={busy || !!active || !!classifying}
        onClose={() => setDialog(null)} onError={onError} />}
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
      {dialog === "collection" && (
        <Modal
          title="새 컬렉션"
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task(async () => {
                await window.bunny.createCollection({ projectId, name });
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
      {dialog === "deleteTrash" && trashDeletion && (
        <Modal
          title={
            trashDeletion.request.target.kind === "all"
              ? "휴지통 비우기"
              : "선택 문헌 영구 삭제"
          }
          onClose={() => {
            if (!busy) {
              setDialog(null);
              setTrashDeletion(null);
            }
          }}
        >
          <p>
            {trashDeletion.request.target.kind === "all"
              ? `검색·필터와 관계없이 이 프로젝트의 휴지통에 있는 문헌 ${trashDeletion.count}편을 모두 영구 삭제합니다.`
              : `선택한 문헌 ${trashDeletion.count}편을 이 프로젝트에서 영구 삭제합니다.`}
          </p>
          <p>
            문헌의 메모와 컬렉션 연결도 삭제되며, 복원하거나 실행 취소할 수
            없습니다. 다른 프로젝트의 문헌은 유지됩니다.
          </p>
          {trashDeletion.shelfFiles.length > 0 && (
            <div className="trash-shelf-files" role="alert">
              <p className="danger">
                서고 PDF {trashDeletion.shelfFiles.length}개도 디스크에서 바로
                지웁니다. 휴지통을 거치지 않으며, 모든 프로젝트의 서고에서
                사라집니다.
              </p>
              <ul>
                {trashDeletion.shelfFiles.slice(0, 5).map((path) => (
                  <li key={path} title={path}>{path}</li>
                ))}
                {trashDeletion.shelfFiles.length > 5 && (
                  <li className="subtle">외 {trashDeletion.shelfFiles.length - 5}개</li>
                )}
              </ul>
            </div>
          )}
          <footer className="modal-footer">
            <button
              disabled={busy}
              onClick={() => {
                setDialog(null);
                setTrashDeletion(null);
              }}
            >
              취소
            </button>
            <button
              className="danger"
              disabled={busy || !trashDeletion.count}
              onClick={deleteTrash}
            >
              {busy ? "삭제 중…" : `${trashDeletion.count}편 영구 삭제`}
            </button>
          </footer>
        </Modal>
      )}
      {dialog === "bulk" && (
        <Modal
          title={`${selected.length}편 일괄 편집`}
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveToCollection(bulkTarget);
            }}
          >
            <label className="field">
              컬렉션
              <select
                value={bulkTarget}
                onChange={(e) => setBulkCollection(e.target.value)}
              >
                <option value="" disabled>
                  컬렉션 선택
                </option>
                {snapshot.collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value={NEW_COLLECTION}>+ 새 컬렉션 만들기…</option>
              </select>
            </label>
            {bulkCreating && (
              <label className="field">
                새 컬렉션 이름
                <input
                  autoFocus
                  maxLength={160}
                  value={bulkCollectionName}
                  onChange={(e) => setBulkCollectionName(e.target.value)}
                  placeholder="예: 서론 핵심 문헌"
                />
              </label>
            )}
            <button
              type="submit"
              disabled={
                busy ||
                !selected.length ||
                !bulkTarget ||
                (bulkCreating && !bulkCollectionName.trim())
              }
            >
              {bulkCreating ? <Plus size={14} /> : <Folder size={14} />}
              {bulkCreating ? "만들고 저장" : "컬렉션에 저장"}
            </button>
          </form>
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
            {scope !== "trash" && (
              <button
                className="danger"
                disabled={busy || !selected.length}
                onClick={trashSelected}
              >
                <Trash2 size={14} />
                휴지통
              </button>
            )}
            {scope === "trash" && (
              <button
                className="danger"
                disabled={busy || !!active || !selected.length}
                onClick={() => confirmTrashDeletion()}
              >
                <Trash2 size={14} />
                선택 영구 삭제
              </button>
            )}
            {scope === "trash" && (
              <button disabled={busy || !selected.length} onClick={restoreSelected}>
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
    </div>
  );
}
