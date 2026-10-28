import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { BookOpenText, Info, LoaderCircle } from "lucide-react";
import type { PassageHit, PassageSearchResult } from "../../shared/passages";

/** Search words marked in a passage; text is split, never parsed as HTML. */
function highlight(text: string, terms: string[]): ReactNode {
  const words = terms.filter((t) => t.length >= 2).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return text;
  const pattern = new RegExp(`(${words.join("|")})`, "giu");
  return text.split(pattern).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

const pages = (hit: PassageHit) => (hit.pageEnd > hit.page ? `p. ${hit.page}–${hit.pageEnd}` : `p. ${hit.page}`);

function Passage({ hit, terms, onOpen }: { hit: PassageHit; terms: string[]; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const long = hit.text.length > 520;
  return <li className="passage">
    <div className="passage-meta">
      <button className="passage-page" title="원문에서 이 쪽 열기" aria-label={`원문 ${pages(hit)} 열기`} onClick={onOpen}><BookOpenText size={12} aria-hidden="true" />{pages(hit)}</button>
      {hit.section && <span className="passage-section" title={hit.section}>{hit.section}</span>}
      <span className="passage-match" title="어휘 일치 순위 · 의미 유사 순위">{hit.lexicalRank ? `단어 ${hit.lexicalRank}` : ""}{hit.lexicalRank && hit.semanticRank ? " · " : ""}{hit.semanticRank ? `의미 ${hit.semanticRank}` : ""}</span>
    </div>
    <p className={`passage-text${long && !open ? " clamped" : ""}`}>{highlight(hit.text.replace(/\n\n/g, "\n"), terms)}</p>
    {long && <button className="text-button passage-more" onClick={() => setOpen(!open)}>{open ? "접기" : "구절 전체 보기"}</button>}
  </li>;
}

/**
 * Passages from the shelf PDFs for the current search, grouped under their
 * papers in rank order. A passage opens the reader at its page.
 */
export function PassageResults({ projectId, query, folderId, onOpen, onInspect, onError }: {
  projectId: string;
  query: string;
  folderId?: string;
  onOpen: (workId: string, attachmentId: string | undefined, page: number) => void;
  onInspect: (workId: string) => void;
  onError: (error: unknown) => void;
}) {
  const [result, setResult] = useState<PassageSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.bunny.passageSearch({ projectId, query, folderId, limit: 40 })
      .then((next) => { if (!cancelled) setResult(next); })
      .catch((error) => { if (!cancelled) onError(error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, query, folderId]);
  const groups = useMemo(() => {
    const byWork = new Map<string, PassageHit[]>();
    for (const hit of result?.hits || []) byWork.set(hit.workId, [...(byWork.get(hit.workId) || []), hit]);
    return [...byWork.values()];
  }, [result]);
  if (loading && !result) return <div className="results-loading"><LoaderCircle size={24} className="spin" /><span>본문에서 찾는 중…</span></div>;
  if (!result) return null;
  const { coverage } = result;
  const partial = coverage.docs < coverage.total || coverage.embedded < coverage.passages;
  return <div className="passage-results" aria-busy={loading}>
    {partial && <p className="passage-coverage" role="note"><Info size={13} aria-hidden="true" />
      본문 색인 진행 중 · PDF {coverage.docs.toLocaleString()}/{coverage.total.toLocaleString()}편, 구절 임베딩 {coverage.embedded.toLocaleString()}/{coverage.passages.toLocaleString()}개. 아직 색인되지 않은 논문은 결과에 없습니다.
    </p>}
    {!result.semantic && <p className="passage-coverage" role="note"><Info size={13} aria-hidden="true" />Ollama를 쓸 수 없어 검색어가 들어 있는 구절만 찾았습니다.</p>}
    {!groups.length ? <div className="passage-empty"><h2>‘{query}’에 맞는 본문 구절을 찾지 못했습니다.</h2><p>다른 표현으로 찾거나 논문 검색으로 바꿔 보세요.</p></div>
      : <ol className="passage-groups">
        {groups.map((hits) => {
          const first = hits[0];
          return <li key={first.workId} className="passage-group">
            <header>
              <button className="passage-title" onClick={() => onInspect(first.workId)} title="논문 정보 보기">
                <strong>{first.title}</strong>
                <span>{first.authors.slice(0, 2).join(" · ") || "저자 미상"}{first.authors.length > 2 ? " 외" : ""} · {first.year || "연도 미상"}</span>
              </button>
              <span className="folder-chip" title={first.folder}>{first.folder.split("/").pop() || "수신함"}</span>
            </header>
            <ol className="passage-list">
              {hits.map((hit) => <Passage key={hit.passageId} hit={hit} terms={result.terms} onOpen={() => onOpen(hit.workId, hit.attachmentId ?? undefined, hit.page)} />)}
            </ol>
          </li>;
        })}
      </ol>}
  </div>;
}
