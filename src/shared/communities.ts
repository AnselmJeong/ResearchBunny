/**
 * Louvain community detection (Blondel et al., 2008) on an undirected weighted
 * graph: each node moves to the neighbouring community that raises modularity
 * most, then communities collapse into nodes and the pass repeats until nothing
 * moves. Nodes are visited in the order given, so a result is reproducible.
 * Returns a community number per id: 0 is the largest, ties go to the community
 * whose first member comes first. Papers with no links stay alone.
 */
export function louvain(
  ids: string[],
  edges: { source: string; target: string; weight: number }[],
  resolution = 1,
): Map<string, number> {
  const index = new Map(ids.map((id, i) => [id, i]));
  let adjacency: Map<number, number>[] = ids.map(() => new Map());
  let selfLoops = new Float64Array(ids.length);
  for (const { source, target, weight } of edges) {
    const a = index.get(source), b = index.get(target);
    if (a === undefined || b === undefined || a === b || !(weight > 0)) continue;
    adjacency[a].set(b, (adjacency[a].get(b) ?? 0) + weight);
    adjacency[b].set(a, (adjacency[b].get(a) ?? 0) + weight);
  }
  // Which collapsed node each original paper belongs to.
  let membership = ids.map((_, i) => i);
  for (;;) {
    const size = adjacency.length;
    const degree = new Float64Array(size);
    let total = 0;
    for (let i = 0; i < size; i++) {
      for (const weight of adjacency[i].values()) degree[i] += weight;
      degree[i] += 2 * selfLoops[i];
      total += degree[i];
    }
    if (total === 0) break;
    const community = Int32Array.from({ length: size }, (_, i) => i);
    const communityDegree = Float64Array.from(degree);
    let moved = false;
    for (let improved = true; improved; ) {
      improved = false;
      for (let i = 0; i < size; i++) {
        const current = community[i];
        const linksTo = new Map<number, number>();
        for (const [j, weight] of adjacency[i]) linksTo.set(community[j], (linksTo.get(community[j]) ?? 0) + weight);
        communityDegree[current] -= degree[i];
        // Modularity gain of joining c, up to a constant factor: links into c less the expected share.
        const gain = (c: number) => (linksTo.get(c) ?? 0) - (resolution * communityDegree[c] * degree[i]) / total;
        let best = current, bestGain = gain(current);
        for (const c of linksTo.keys()) {
          const value = gain(c);
          if (value > bestGain + 1e-12) {
            best = c;
            bestGain = value;
          }
        }
        communityDegree[best] += degree[i];
        if (best !== current) {
          community[i] = best;
          improved = moved = true;
        }
      }
    }
    if (!moved) break;
    const renumber = new Map<number, number>();
    for (let i = 0; i < size; i++) if (!renumber.has(community[i])) renumber.set(community[i], renumber.size);
    const count = renumber.size;
    const nextAdjacency: Map<number, number>[] = Array.from({ length: count }, () => new Map());
    const nextSelfLoops = new Float64Array(count);
    for (let i = 0; i < size; i++) {
      const ci = renumber.get(community[i])!;
      nextSelfLoops[ci] += selfLoops[i];
      for (const [j, weight] of adjacency[i]) {
        const cj = renumber.get(community[j])!;
        // Each internal link is listed at both ends, so each listing adds half.
        if (ci === cj) nextSelfLoops[ci] += weight / 2;
        else nextAdjacency[ci].set(cj, (nextAdjacency[ci].get(cj) ?? 0) + weight);
      }
    }
    membership = membership.map((node) => renumber.get(community[node])!);
    adjacency = nextAdjacency;
    selfLoops = nextSelfLoops;
    if (count === size) break;
  }
  const members = new Map<number, number[]>();
  membership.forEach((c, i) => {
    const list = members.get(c);
    if (list) list.push(i);
    else members.set(c, [i]);
  });
  const ranked = [...members.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
  const result = new Map<string, number>();
  ranked.forEach((list, number) => {
    for (const i of list) result.set(ids[i], number);
  });
  return result;
}

/**
 * Title words that say nothing about a topic. Field words such as "memory" or
 * "dopamine" are deliberately absent: they name a cluster precisely when they
 * are rare in the other clusters.
 */
const STOPWORDS = new Set(
  `a an the of and or for with via using used based towards toward from into on in to by at as is are was were be been
  being we our this that these those its it their they can could may might will would should not no than then there
  here also such more most less very much many few both each other others between among within without over under
  about across after before during through per vs versus et al new novel approach approaches method methods
  framework frameworks system systems study studies analysis analyses paper papers result results work works
  present presents propose proposed introduce introduces show shows state art survey review reviews case cases
  application applications efficient effective robust general unified simple fast scalable evidence role roles
  effect effects model models modeling modelling data use test tests testing toward understanding insights
  perspective perspectives approach implications`
    .split(/\s+/)
    .filter(Boolean),
);

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

function words(title: string): string[] {
  return fold(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && word.length <= 30 && !/^\d+$/.test(word));
}

/** Distinct content words and adjacent word pairs of one title. */
function terms(title: string): Set<string> {
  const list = words(title);
  const found = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    if (STOPWORDS.has(list[i])) continue;
    found.add(list[i]);
    // Only neighbours form a phrase, so dropping a stopword never joins words across it.
    if (i + 1 < list.length && !STOPWORDS.has(list[i + 1])) found.add(`${list[i]} ${list[i + 1]}`);
  }
  return found;
}

export interface ClusterSummary {
  /** Community number from `louvain`: 0 is the largest. */
  id: number;
  ids: string[];
  /** Up to three distinctive title terms, or a fallback name. */
  label: string;
  keywords: string[];
  years: [number, number] | null;
  /** The most common OpenAlex topic among members. */
  topic: string | null;
  /** The most common folder or archive topic, with its share of the cluster. */
  group: { name: string; share: number } | null;
  /** Up to three representative paper ids, best first. */
  top: string[];
}

function mostCommon(values: (string | null | undefined)[]): { name: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { name: string; count: number } | null = null;
  for (const [name, count] of counts)
    if (!best || count > best.count || (count === best.count && name.localeCompare(best.name) < 0)) best = { name, count };
  return best;
}

/**
 * Describe every community of two or more papers, largest first. The label is
 * class-based TF-IDF over titles: terms many members share that are rare in
 * the other clusters ("working memory · prefrontal"). Phrases count a bit more
 * than single words; a term sharing a word with one already chosen is skipped,
 * and a term a larger cluster's label already uses is taken only when nothing
 * else is left, so two halves of one topic do not get the same name.
 */
export function summarizeClusters(
  works: { id: string; title: string; year: number | null; topics?: { name: string }[] }[],
  membership: Map<string, number>,
  options: { rank?: (id: string) => number; group?: (id: string) => string | null } = {},
): ClusterSummary[] {
  const groups = new Map<number, typeof works>();
  for (const work of works) {
    const c = membership.get(work.id);
    if (c === undefined) continue;
    const list = groups.get(c);
    if (list) list.push(work);
    else groups.set(c, [work]);
  }
  const clusters = [...groups].filter(([, members]) => members.length >= 2).sort((a, b) => a[0] - b[0]);
  const counts = new Map<number, Map<string, number>>();
  const spread = new Map<string, number>();
  for (const [c, members] of clusters) {
    const tally = new Map<string, number>();
    for (const work of members) for (const term of terms(work.title)) tally.set(term, (tally.get(term) ?? 0) + 1);
    counts.set(c, tally);
    for (const term of tally.keys()) spread.set(term, (spread.get(term) ?? 0) + 1);
  }
  const rank = options.rank ?? (() => 0);
  const used = new Set<string>();
  return clusters.map(([c, members]) => {
    const tally = counts.get(c)!;
    const needed = Math.min(2, members.length);
    const scored = [...tally]
      .filter(([, count]) => count >= needed)
      .map(([term, count]) => ({
        term,
        score: count * (term.includes(" ") ? 1.6 : 1) * Math.log((1 + clusters.length) / (1 + spread.get(term)!)),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
    const keywords: string[] = [];
    const wordsOf = (term: string) => term.split(" ");
    const overlaps = (term: string) => keywords.some((chosen) => wordsOf(term).some((word) => wordsOf(chosen).includes(word)));
    for (const fresh of [true, false]) {
      for (const { term } of scored) {
        if (keywords.length === 3) break;
        if (keywords.includes(term) || overlaps(term) || (fresh && used.has(term))) continue;
        keywords.push(term);
      }
      if (keywords.length) break;
    }
    for (const term of keywords) used.add(term);
    const years = members.map((work) => work.year).filter((year): year is number => year !== null);
    const topic = mostCommon(members.map((work) => work.topics?.[0]?.name))?.name ?? null;
    const group = options.group ? mostCommon(members.map((work) => options.group!(work.id))) : null;
    const top = [...members].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 3).map((work) => work.id);
    const lead = members.find((work) => work.id === top[0]);
    return {
      id: c,
      ids: members.map((work) => work.id),
      label: keywords.join(" · ") || topic || (lead ? lead.title.split(/[:.?]/)[0].slice(0, 40) : `군집 ${c + 1}`),
      keywords,
      years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      topic,
      group: group ? { name: group.name, share: group.count / members.length } : null,
      top,
    };
  });
}
