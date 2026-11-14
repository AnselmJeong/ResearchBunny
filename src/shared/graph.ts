import type { InferredLink } from "./types";

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

/**
 * Log-scaled diameter from 24 to 64 model pixels. `floor` is the smallest
 * value treated as the top of the scale, so a small maximum in a sparse graph
 * does not draw as a full-size hub.
 */
function logDiameter(value: number, maximum: number, floor: number): number {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const ceiling = Math.max(floor, Number.isFinite(maximum) ? maximum : 0, safe);
  return 24 + 40 * Math.log1p(safe) / Math.log1p(ceiling);
}

/** Log-scaled side length (diameter for circles), bounded in model pixels. */
export function citationNodeDiameter(count: number, maximum: number): number {
  // Keep a solitary citation from becoming a full-size hub in sparse graphs.
  return logDiameter(count, maximum, 10);
}

/**
 * Diameter for a PageRank score given as a multiple of the average share.
 * The scale starts at the graph's lowest score, so papers nobody here cites
 * stay smallest; a nearly flat graph keeps nearly equal sizes.
 */
export function rankNodeDiameter(score: number, lowest: number, highest: number): number {
  return logDiameter(score - lowest, highest - lowest, 1);
}

/**
 * PageRank over citation links (citing → cited): a paper ranks higher when
 * papers that rank high themselves cite it. A paper citing nothing in the
 * graph shares its rank evenly, so scores sum to 1. Self-citations, repeated
 * links and links to papers outside `ids` are ignored.
 */
export function pageRank(
  ids: string[],
  edges: { source: string; target: string }[],
  damping = 0.85,
): Map<string, number> {
  const n = ids.length;
  if (!n) return new Map();
  const index = new Map(ids.map((id, i) => [id, i]));
  const out: number[][] = ids.map(() => []);
  const seen = new Set<string>();
  for (const { source, target } of edges) {
    const from = index.get(source), to = index.get(target);
    if (from === undefined || to === undefined || from === to || seen.has(`${from}:${to}`)) continue;
    seen.add(`${from}:${to}`);
    out[from].push(to);
  }
  let rank = new Float64Array(n).fill(1 / n);
  for (let iteration = 0; iteration < 100; iteration++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!out[i].length) dangling += rank[i];
      else for (const to of out[i]) next[to] += rank[i] / out[i].length;
    }
    const base = (1 - damping) / n + (damping * dangling) / n;
    let change = 0;
    for (let i = 0; i < n; i++) {
      next[i] = base + damping * next[i];
      change += Math.abs(next[i] - rank[i]);
    }
    rank = next;
    if (change < 1e-10) break;
  }
  return new Map(ids.map((id, i) => [id, rank[i]]));
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

/** Keep each paper's `perNode` strongest pairs; a pair stays when either side keeps it. */
function strongestPerNode(pairs: { a: number; b: number; weight: number }[], n: number, perNode: number) {
  const best: number[][] = Array.from({ length: n }, () => []);
  const order = pairs.map((_, index) => index).sort((x, y) => pairs[y].weight - pairs[x].weight || x - y);
  const kept = new Set<number>();
  for (const index of order) {
    const { a, b } = pairs[index];
    if (best[a].length < perNode || best[b].length < perNode) {
      kept.add(index);
      if (best[a].length < perNode) best[a].push(index);
      if (best[b].length < perNode) best[b].push(index);
    }
  }
  return order.filter((index) => kept.has(index));
}

/**
 * Bibliographic coupling: papers that cite the same works sit in the same
 * research context. Strength is Salton's cosine, shared / sqrt(|A| · |B|) over
 * full reference lists, including works outside the graph. A pair needs
 * `minShared` shared references and each paper keeps only its `perNode`
 * strongest partners, so a dense field does not become a mesh. References
 * cited by more than half of a sizeable set, or by more than 150 of its
 * papers, link everything and are skipped; the cap also keeps a shelf-sized
 * set to well under a second.
 */
export function couplingLinks(
  references: Map<string, string[]>,
  { minShared = 3, perNode = 3 }: { minShared?: number; perNode?: number } = {},
): InferredLink[] {
  const ids = [...references.keys()];
  const n = ids.length;
  const citers = new Map<string, number[]>();
  const sizes = ids.map((id, index) => {
    const distinct = new Set(references.get(id));
    for (const reference of distinct) {
      const list = citers.get(reference);
      if (list) list.push(index);
      else citers.set(reference, [index]);
    }
    return distinct.size;
  });
  const ceiling = n >= 20 ? Math.min(150, Math.max(20, n / 2)) : Infinity;
  const shared = new Map<number, number>();
  for (const list of citers.values()) {
    if (list.length < 2 || list.length > ceiling) continue;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const key = list[i] * n + list[j];
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
  }
  const pairs: { a: number; b: number; weight: number; count: number }[] = [];
  for (const [key, count] of shared) {
    if (count < minShared) continue;
    const a = Math.floor(key / n), b = key % n;
    pairs.push({ a, b, count, weight: count / Math.sqrt(sizes[a] * sizes[b]) });
  }
  return strongestPerNode(pairs, n, perNode).map((index) => {
    const { a, b, weight, count } = pairs[index];
    const [source, target] = [ids[a], ids[b]].sort();
    return { source, target, kind: "coupling" as const, weight, shared: count };
  });
}

/**
 * Each paper's nearest neighbours by embedding cosine. Only pairs at or above
 * the `quantile` of all pairwise similarities in this set count, so papers
 * unlike everything else here are not linked just because something is
 * nearest; each paper then keeps its `perNode` closest partners.
 */
export function semanticLinks(
  vectors: Map<string, Float32Array>,
  { perNode = 2, quantile = 0.9 }: { perNode?: number; quantile?: number } = {},
): InferredLink[] {
  const ids = [...vectors.keys()].filter((id) => vectors.get(id)!.length);
  const n = ids.length;
  if (n < 2) return [];
  const dim = vectors.get(ids[0])!.length;
  const data = new Float32Array(n * dim);
  ids.forEach((id, row) => {
    const vector = vectors.get(id)!;
    if (vector.length !== dim) return;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) data[row * dim + i] = vector[i] / norm;
  });
  const similarity = new Float32Array((n * (n - 1)) / 2);
  let at = 0;
  for (let a = 0; a < n; a++) {
    const offsetA = a * dim;
    for (let b = a + 1; b < n; b++) {
      const offsetB = b * dim;
      // Four accumulators let the JIT overlap the multiply-adds: about 1.6x faster than one.
      let d0 = 0, d1 = 0, d2 = 0, d3 = 0, i = 0;
      for (; i + 3 < dim; i += 4) {
        d0 += data[offsetA + i] * data[offsetB + i];
        d1 += data[offsetA + i + 1] * data[offsetB + i + 1];
        d2 += data[offsetA + i + 2] * data[offsetB + i + 2];
        d3 += data[offsetA + i + 3] * data[offsetB + i + 3];
      }
      for (; i < dim; i++) d0 += data[offsetA + i] * data[offsetB + i];
      similarity[at++] = d0 + d1 + d2 + d3;
    }
  }
  const sorted = similarity.slice().sort();
  const floor = sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
  const pairs: { a: number; b: number; weight: number }[] = [];
  at = 0;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++, at++) if (similarity[at] >= floor) pairs.push({ a, b, weight: similarity[at] });
  return strongestPerNode(pairs, n, perNode).map((index) => {
    const { a, b, weight } = pairs[index];
    const [source, target] = [ids[a], ids[b]].sort();
    return { source, target, kind: "semantic" as const, weight };
  });
}
