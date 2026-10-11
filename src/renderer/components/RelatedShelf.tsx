import { useEffect, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { ShelfRelated, ShelfRelatedItem } from "../../shared/shelf";
import type { WorkView } from "../../shared/types";

function Item({ item, onInspect, similarity }: { item: ShelfRelatedItem; onInspect: (id: string) => void; similarity: boolean }) {
  return <button className="related-paper" onClick={() => onInspect(item.workId)} title={item.title}>
    <span className="related-title">{item.title}</span>
    <span className="related-meta">
      {similarity && <span className="similarity" aria-label={`유사도 ${item.score.toFixed(2)}`}><span style={{ width: `${Math.max(4, Math.min(100, (item.score - 0.5) * 200))}%` }} /></span>}
      <span>{item.year || "연도 미상"}</span>
      {item.folder && <span className="folder-chip">{item.folder.split("/").pop()}</span>}
      {item.lowConfidence && <span className="warning-text">초록 없음 · 정확도 낮음</span>}
    </span>
    <ChevronRight size={13} />
  </button>;
}

/** Inspector tab: similar shelf papers (local embeddings) and shelf papers linked by citation. */
export function RelatedShelf({ projectId, work, active, configured, onInspect, onError }: {
  projectId: string;
  work: WorkView;
  active: boolean;
  configured: boolean;
  onInspect: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const [otherFolders, setOtherFolders] = useState(false);
  const [data, setData] = useState<{ key: string; value: ShelfRelated } | null>(null);
  const key = `${projectId}:${work.id}:${otherFolders}`;
  useEffect(() => {
    if (!active || !configured || data?.key === key) return;
    let valid = true;
    void window.bunny.shelfRelated({ projectId, workId: work.id, limit: 10, otherFoldersOnly: otherFolders })
      .then((value) => { if (valid) setData({ key, value }); })
      .catch((error) => { if (valid) onError(error); });
    return () => { valid = false; };
  }, [active, configured, key]);
  if (!configured) return <p className="subtle">설정에서 서고를 연결하면 가지고 있는 PDF 가운데 비슷한 논문을 추천합니다.</p>;
  const related = data?.key === key ? data.value : null;
  if (!related) return <p className="subtle related-loading"><LoaderCircle size={14} className="spin" /> 서고에서 찾는 중…</p>;
  return <section className="related-shelf">
    <div className="note-heading">
      <h3>비슷한 서고 논문</h3>
      {work.shelf && <label className="check"><input type="checkbox" checked={otherFolders} onChange={(e) => setOtherFolders(e.target.checked)} />다른 폴더만</label>}
    </div>
    {related.notice && <p className="subtle">{related.notice}</p>}
    {related.similar.length
      ? related.similar.map((item) => <Item key={item.workId} item={item} onInspect={onInspect} similarity />)
      : related.semantic && <p className="subtle">비슷한 서고 논문이 없습니다.</p>}
    <h3>인용으로 이어진 서고 논문</h3>
    {!related.cites.length && !related.citedBy.length && <p className="subtle">확인된 인용 관계가 없습니다. 서지가 확인된 논문끼리만 연결됩니다.</p>}
    {!!related.cites.length && <details open><summary>이 논문이 인용한 서고 논문 {related.cites.length}편</summary>
      {related.cites.map((item) => <Item key={item.workId} item={item} onInspect={onInspect} similarity={false} />)}
    </details>}
    {!!related.citedBy.length && <details open><summary>이 논문을 인용한 서고 논문 {related.citedBy.length}편</summary>
      {related.citedBy.map((item) => <Item key={item.workId} item={item} onInspect={onInspect} similarity={false} />)}
    </details>}
    <p className="subtle">초록 임베딩은 이 Mac의 Ollama에서 계산합니다. 외부로 보내지 않습니다.</p>
  </section>;
}
