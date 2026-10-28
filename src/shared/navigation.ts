import { z } from "zod";
import { filtersSchema } from "./contracts";
import { DEFAULT_FILTERS, type ListResult, type Run } from "./types";

const viewSchema = z.object({
  scope: z
    .enum([
      "archive",
      "pending",
      "starred",
      "reading",
      "trash",
      "excluded",
      "run",
      "collection",
      "topic",
      "unclassified",
      "shelf",
    ])
    .default("archive"),
  scopeId: z.string().default(""),
  selected: z.array(z.string()).max(20000).default([]),
  inspectorId: z.string().nullable().default(null),
  inspectorOpen: z.boolean().default(true),
  filters: filtersSchema.default(DEFAULT_FILTERS),
  view: z.enum(["list", "graph", "timeline"]).default("list"),
  // Older `positions` mixed network and timeline coordinates. Do not restore them.
  networkPositions: z
    .record(z.string(), z.object({ x: z.number(), y: z.number() }))
    .default({}),
  query: z.string().default(""),
  localQuery: z.string().default(""),
  sort: z
    .enum(["rank", "year", "citations", "title", "updated"])
    .default("rank"),
  searchSort: z.enum(["relevance", "citations", "year"]).default("relevance"),
  semantic: z.boolean().default(false),
  filtersOpen: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
  basis: z.enum(["selected", "archive"]).default("selected"),
});
export type WorkspaceView = z.infer<typeof viewSchema>;
export interface NavigationHistory {
  keys: string[];
  index: number;
  views: Record<string, WorkspaceView>;
}
export function forgetWorks(
  history: NavigationHistory,
  ids: string[],
): NavigationHistory {
  const removed = new Set(ids);
  return {
    ...history,
    views: Object.fromEntries(
      Object.entries(history.views).map(([key, view]) => [
        key,
        {
          ...view,
          selected: view.selected.filter((id) => !removed.has(id)),
          inspectorId:
            view.inspectorId && removed.has(view.inspectorId)
              ? null
              : view.inspectorId,
          networkPositions: Object.fromEntries(
            Object.entries(view.networkPositions).filter(([id]) => !removed.has(id)),
          ),
          offset: 0,
        },
      ]),
    ),
  };
}
/** Trash hides papers from every other list and restored papers leave the trash, so drop selections those views can no longer show. */
export function deselectWorks(
  history: NavigationHistory,
  ids: string[],
  inTrashViews: boolean,
): NavigationHistory {
  return deselectWhere(history, ids, (view) => (view.scope === "trash") === inTrashViews);
}
/** Drops `ids` from the remembered selections of the views that `where` picks. */
export function deselectWhere(
  history: NavigationHistory,
  ids: string[],
  where: (view: WorkspaceView) => boolean,
): NavigationHistory {
  const removed = new Set(ids);
  if (!removed.size) return history;
  return {
    ...history,
    views: Object.fromEntries(
      Object.entries(history.views).map(([key, view]) => [
        key,
        where(view)
          ? { ...view, selected: view.selected.filter((id) => !removed.has(id)) }
          : view,
      ]),
    ),
  };
}
export const viewKey = (view: Pick<WorkspaceView, "scope" | "scopeId">) =>
  `${view.scope}:${view.scopeId}`;
/** Names the papers a view lists, whatever page or order it shows them in. */
export const listKey = (
  view: Pick<WorkspaceView, "scope" | "scopeId" | "localQuery" | "filters"> & { graph: boolean },
) => JSON.stringify([view.scope, view.scopeId, view.localQuery, view.filters, view.graph]);
/** Papers a list shows: its results on every page, its shelf matches and its graph context. */
export const listMembers = (list: Pick<ListResult, "ids" | "context" | "shelf">) =>
  new Set([
    ...list.ids,
    ...(list.context || []).map((work) => work.id),
    ...(list.shelf || []).map((work) => work.id),
  ]);
/** The inspector's paper and whether it must stay in its list. */
export interface InspectorAnchor {
  id: string | null;
  /** Opened from the list or remembered with the view, not from outside it (a related paper, an AI source). */
  listed: boolean;
  /** `listKey` of the list it was last checked against. */
  key: string;
}
/**
 * Checks the inspector's paper against a list that just loaded. When the same list no longer holds a listed paper,
 * the paper was trashed, taken out of the view or undone, or left a remembered view while it was away: the inspector
 * drops it. A paper that a new search or filter only hides, or one opened from outside the list, stays.
 */
export function anchorInspector(
  anchor: InspectorAnchor,
  members: ReadonlySet<string>,
  key: string,
): { anchor: InspectorAnchor; drop: boolean } {
  const present = !!anchor.id && members.has(anchor.id);
  const drop = !!anchor.id && !present && anchor.listed && anchor.key === key;
  return { anchor: { id: drop ? null : anchor.id, listed: present, key }, drop };
}
export const defaultView = (
  value: Partial<WorkspaceView> = {},
): WorkspaceView => viewSchema.parse(value);
export function restoreNavigation(
  ui: Record<string, unknown>,
): NavigationHistory {
  const parsed = z
    .object({
      keys: z.array(z.string()).max(100),
      index: z.number().int().min(0),
      views: z.record(z.string(), viewSchema),
    })
    .safeParse(ui.navigation);
  if (parsed.success) {
    const h = parsed.data;
    if (
      h.index < h.keys.length &&
      h.keys.every((k) => h.views[k] && viewKey(h.views[k]) === k)
    )
      return h;
  }
  const old = viewSchema.safeParse(ui);
  const view = old.success ? old.data : defaultView();
  return { keys: [viewKey(view)], index: 0, views: { [viewKey(view)]: view } };
}
/** A new launch keeps every view's place but not its search words, which belonged to the last session. */
export function withoutSearches(history: NavigationHistory): NavigationHistory {
  return {
    ...history,
    views: Object.fromEntries(
      Object.entries(history.views).map(([key, view]) => [key, view.localQuery ? { ...view, localQuery: "", offset: 0 } : view]),
    ),
  };
}
export function rememberView(
  history: NavigationHistory,
  view: WorkspaceView,
): NavigationHistory {
  const key = viewKey(view);
  const keys = history.keys.length ? history.keys : [key];
  return {
    ...history,
    keys,
    views: { ...history.views, [key]: structuredClone(view) },
  };
}
export function visitView(
  history: NavigationHistory,
  current: WorkspaceView,
  next: WorkspaceView,
): NavigationHistory {
  const saved = rememberView(history, current);
  const key = viewKey(next);
  const keys = saved.keys.slice(0, saved.index + 1);
  if (keys.at(-1) !== key) keys.push(key);
  return compactNavigation({
    keys,
    index: keys.length - 1,
    views: { ...saved.views, [key]: structuredClone(next) },
  });
}
export function moveHistory(
  history: NavigationHistory,
  current: WorkspaceView,
  delta: number,
): NavigationHistory {
  const saved = rememberView(history, current);
  return {
    ...saved,
    index: Math.max(0, Math.min(saved.keys.length - 1, saved.index + delta)),
  };
}
// Bound UI preferences without deleting any saved exploration runs or papers.
export function compactNavigation(
  history: NavigationHistory,
): NavigationHistory {
  let h = { ...history, keys: [...history.keys], views: { ...history.views } };
  const current = h.keys[h.index];
  const ordered = [...new Set([...h.keys, ...Object.keys(h.views)])];
  while (
    (Object.keys(h.views).length > 40 || JSON.stringify(h).length > 850000) &&
    Object.keys(h.views).length > 1
  ) {
    const key = ordered.find((k) => k !== current && h.views[k]);
    if (!key) break;
    delete h.views[key];
    const before = h.keys.slice(0, h.index).filter((k) => k !== key).length;
    h.keys = h.keys.filter((k) => k !== key);
    h.index = before;
  }
  if (h.keys.length > 60) {
    const start = Math.max(0, h.index - 30);
    h = { ...h, keys: h.keys.slice(start, start + 60), index: h.index - start };
  }
  return h;
}
export function runPath(runs: Run[], id: string): Run[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const path: Run[] = [];
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}
