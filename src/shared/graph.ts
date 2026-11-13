/** Graphs use the whole filtered scope up to the rendering limit, independently of list pages. */
export const GRAPH_LIMIT = 1000;

/**
 * Papers worth drawing: those linked to another listed or context paper.
 * Past the limit the best-connected papers win; the result keeps the scope's order.
 */
export function graphNodeIds(
  ids: string[],
  contextIds: string[],
  edges: { source: string; target: string }[],
  limit = GRAPH_LIMIT,
): { ids: string[]; connected: number } {
  const members = new Set([...ids, ...contextIds]);
  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a)!.add(b);
  };
  for (const { source, target } of edges)
    if (source !== target && members.has(source) && members.has(target)) {
      link(source, target);
      link(target, source);
    }
  const degree = (id: string) => neighbors.get(id)?.size ?? 0;
  const connected = ids.filter((id) => degree(id) > 0);
  if (connected.length <= limit) return { ids: connected, connected: connected.length };
  const rank = new Map(connected.map((id, index) => [id, index]));
  const chosen = new Set(
    [...connected].sort((a, b) => degree(b) - degree(a) || rank.get(a)! - rank.get(b)!).slice(0, limit),
  );
  const anchors = new Set([...chosen, ...contextIds]);
  // A paper whose only neighbours fell past the limit would be a new singleton.
  return {
    ids: connected.filter((id) => chosen.has(id) && [...neighbors.get(id)!].some((other) => anchors.has(other))),
    connected: connected.length,
  };
}

/** Count distinct citing papers in this scope, not outgoing references. */
export function incomingCitationCounts(
  ids: string[],
  edges: { source: string; target: string }[],
): Map<string, number> {
  const sources = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const { source, target } of edges) {
    if (source !== target && sources.has(source)) sources.get(target)?.add(source);
  }
  return new Map([...sources].map(([id, citing]) => [id, citing.size]));
}

/** Log-scaled side length (diameter for circles), bounded in model pixels. */
export function citationNodeDiameter(count: number, maximum: number): number {
  const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
  // Keep a solitary citation from becoming a full-size hub in sparse graphs.
  const ceiling = Math.max(10, Number.isFinite(maximum) ? maximum : 0, safeCount);
  return 24 + 40 * Math.log1p(safeCount) / Math.log1p(ceiling);
}

/** Case- and accent-free text, so "menard" finds "Ménard". */
const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Papers on the graph matching every word of `query`, in any order, against
 * what a node and its tooltip show: title, authors, year, venue and citekey.
 */
export function graphSearch(
  works: { id: string; title: string; authors: string[]; year: number | null; venue?: string; citekey?: string }[],
  query: string,
): string[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return works
    .filter((work) => {
      const text = fold([work.title, ...work.authors, work.year ?? "", work.venue ?? "", work.citekey ?? ""].join(" "));
      return words.every((word) => text.includes(word));
    })
    .map((work) => work.id);
}

export function resultWindow(graph: boolean, limit: number, offset: number) {
  return { graph, limit, offset: graph ? 0 : offset };
}

export function citationWarnings(
  works: { id: string; year: number | null }[],
  edges: { source: string; target: string }[],
): Map<string, string> {
  const years = new Map(works.map((work) => [work.id, work.year]));
  const pairs = new Set(edges.map((edge) => `${edge.source}:${edge.target}`));
  const warnings = new Map<string, string>();
  for (const { source, target } of edges) {
    const a = years.get(source),
      b = years.get(target);
    if (a != null && b != null && a < b) {
      warnings.set(
        `${source}:${target}`,
        `연도 역전: ${a}년 논문이 ${b}년 논문을 인용하는 기록입니다. 출판일·원문 참고문헌 확인이 필요합니다.`,
      );
    } else if (
      pairs.has(`${target}:${source}`) &&
      !(a != null && b != null && a > b)
    ) {
      warnings.set(
        `${source}:${target}`,
        "양방향 인용 기록입니다. 연도만으로 방향을 판단할 수 없어 원문 참고문헌 확인이 필요합니다.",
      );
    }
  }
  return warnings;
}
