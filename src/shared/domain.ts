import type { Work, WorkView, Filters, Evidence } from "./types";
import { now } from "./types";
export function normalizeDoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const doi = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}
export function normalizeOpenAlex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
  return match ? match[1].toUpperCase() : null;
}
/** Provider similarity has no citation direction and is kept out of citation_edges. */
export function similarityEdges(
  works: Work[],
): { source: string; target: string }[] {
  const ids = new Map(
    works.filter((w) => w.openalex).map((w) => [w.openalex!, w.id]),
  );
  const pairs = new Map<string, { source: string; target: string }>();
  for (const work of works)
    for (const related of work.related) {
      const target = ids.get(related);
      if (!target || target === work.id) continue;
      const [a, b] = [work.id, target].sort();
      pairs.set(`${a}:${b}`, { source: a, target: b });
    }
  return [...pairs.values()];
}
export function restoreAbstract(index: unknown): string | null {
  if (!index || typeof index !== "object" || Array.isArray(index)) return null;
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) return null;
    for (const p of positions) {
      if (!Number.isInteger(p) || p < 0 || p > 50000 || words.has(p))
        return null;
      words.set(p, word);
    }
  }
  return words.size
    ? [...words.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((x) => x[1])
        .join(" ")
    : null;
}
const STOP = new Set(
  "a an the of on in and or for to with from by is are as at that this we our study using new".split(
    " ",
  ),
);
export function tokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) || []
  ).filter((t) => !STOP.has(t));
}
export function titleSimilarity(a: string, b: string): number {
  const x = new Set(tokens(a)),
    y = new Set(tokens(b));
  const union = new Set([...x, ...y]);
  return union.size ? [...x].filter((t) => y.has(t)).length / union.size : 0;
}
export function blankWork(input: Partial<Work> = {}): Work {
  return {
    id: crypto.randomUUID(),
    openalex: null,
    doi: null,
    title: "제목 미확인",
    authors: [],
    year: null,
    type: "article",
    venue: "",
    abstract: null,
    citations: null,
    topics: [],
    references: null,
    related: [],
    url: null,
    oaUrl: null,
    retracted: false,
    volume: "",
    issue: "",
    pages: "",
    publisher: "",
    citekey: "",
    source: "manual",
    fetchedAt: now(),
    raw: {},
    edits: {},
    ...input,
  };
}
export function relatedness(
  candidates: Work[],
  anchors: Work[],
  question: string,
): Map<string, { score: number | null; seedIds: string[]; deferred: boolean }> {
  const docs = [...candidates, ...anchors].map((w) =>
    tokens(`${w.title} ${w.abstract || ""}`),
  );
  const queries = [
    tokens(question),
    ...anchors.map((w) => tokens(`${w.title} ${w.abstract || ""}`)),
  ].filter((t) => t.length);
  const all = [...docs, ...queries],
    df = new Map<string, number>();
  for (const doc of all)
    for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1);
  const vector = (doc: string[]) => {
    const counts = new Map<string, number>();
    for (const t of doc) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [t, n] of counts)
      counts.set(
        t,
        (1 + Math.log(n)) * Math.log(1 + all.length / (df.get(t) || 1)),
      );
    return counts;
  };
  const cosine = (a: Map<string, number>, b: Map<string, number>) => {
    let dot = 0,
      aa = 0,
      bb = 0;
    for (const [t, v] of a) {
      dot += v * (b.get(t) || 0);
      aa += v * v;
    }
    for (const v of b.values()) bb += v * v;
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  };
  const qvec = queries.map(vector),
    av = anchors.map((w) => vector(tokens(`${w.title} ${w.abstract || ""}`)));
  return new Map(
    candidates.map((w, i) => {
      const v = vector(docs[i]);
      const text = Math.max(0, ...qvec.map((q) => cosine(v, q)));
      const wt = new Set(w.topics.map((t) => t.id));
      const topic = Math.max(
        0,
        ...anchors.map((s) =>
          s.topics.length
            ? s.topics.filter((t) => wt.has(t.id)).length / s.topics.length
            : 0,
        ),
      );
      const score =
        queries.length || anchors.length ? Math.max(text, topic * 0.65) : null;
      return [
        w.id,
        {
          score,
          seedIds: anchors
            .filter(
              (a, j) =>
                cosine(v, av[j]) > 0.1 || a.topics.some((t) => wt.has(t.id)),
            )
            .map((a) => a.id),
          deferred: !w.abstract && (!score || score < 0.15),
        },
      ];
    }),
  );
}
export function filterReasons(
  w: WorkView,
  filters: Filters,
  evidence?: Evidence,
): string[] {
  const reasons: string[] = [];
  const text = `${w.title} ${w.abstract || ""}`.toLocaleLowerCase();
  if (
    filters.minCitations > 0 &&
    (w.citations === null || w.citations < filters.minCitations)
  )
    reasons.push(w.citations === null ? "피인용수 미상" : "최소 피인용수 미달");
  if (w.year === null && !filters.unknownYear) reasons.push("연도 미상");
  if (
    w.year !== null &&
    ((filters.yearFrom !== null && w.year < filters.yearFrom) ||
      (filters.yearTo !== null && w.year > filters.yearTo))
  )
    reasons.push("출판 기간 밖");
  if (filters.types.length && !filters.types.includes(w.type))
    reasons.push("문헌 유형");
  for (const term of filters.include
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean))
    if (!text.includes(term)) reasons.push(`포함어 없음: ${term}`);
  for (const term of filters.exclude
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean))
    if (text.includes(term)) reasons.push(`제외어: ${term}`);
  if (filters.hasAbstract && !w.abstract) reasons.push("초록 없음");
  if (filters.hasPdf && !w.attachmentCount) reasons.push("보관 PDF 없음");
  if (filters.openAccess && !w.oaUrl) reasons.push("OA 링크 없음");
  if (filters.hideSaved && w.state.screening === "included")
    reasons.push("이미 저장됨");
  if (filters.hideExcluded && w.state.screening === "excluded")
    reasons.push("사용자 제외");
  if (filters.hideRetracted && w.retracted && w.state.screening !== "included")
    reasons.push("철회 표시");
  if (
    filters.relevance &&
    evidence?.score !== null &&
    evidence?.score !== undefined &&
    !evidence.deferred &&
    evidence.score <
      { strict: 0.18, balanced: 0.075, broad: 0.015 }[filters.strictness]
  )
    reasons.push("초기 관심과 낮은 관련성");
  if (
    evidence?.relation.startsWith("common") &&
    evidence.seedIds.length < filters.minShared
  )
    reasons.push("공통 연결수 미달");
  return reasons;
}
export function safeWebUrl(value: string | null): string | null {
  try {
    const url = new URL(value || "");
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
