import { z } from "zod";
import { filtersSchema } from "./contracts";
import { DEFAULT_FILTERS, type Run } from "./types";

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
export const viewKey = (view: Pick<WorkspaceView, "scope" | "scopeId">) =>
  `${view.scope}:${view.scopeId}`;
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
