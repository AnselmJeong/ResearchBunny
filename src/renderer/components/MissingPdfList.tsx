import { useState } from "react";
import type { MissingPdfItem } from "../../shared/types";

const statuses = { untried: "미시도", pending: "대기", running: "확보 중", failed: "확보 실패", skipped: "미연결", missing: "재연결 필요" };
export function MissingPdfList({ projectId, items, ready, busy, onError, onConnected }: {
  projectId: string;
  items: MissingPdfItem[];
  ready: boolean;
  busy: boolean;
  onError: (error: unknown) => void;
  onConnected: () => void;
}) {
  const [limit, setLimit] = useState(50);
  const [connecting, setConnecting] = useState(false);
  const connect = async (workId: string) => {
    setConnecting(true);
    try {
      await window.bunny.choosePdf({ projectId, workId, mode: "managed" });
      onConnected();
    } catch (error) { onError(error); } finally { setConnecting(false); }
  };
  return <section className="missing-pdfs" aria-label="현재 원문이 없는 문헌">
    <h3>남은 문헌{ready ? ` · ${items.length}편` : ""}</h3>
    {ready && !items.length && <p className="pdf-connected" role="status">✓ 이 범위의 대상 문헌에 PDF가 모두 연결되었습니다.</p>}
    <ul className="download-items">
      {items.slice(0, limit).map(item => <li key={item.workId}>
        <strong>{item.title}</strong>
        <p className="subtle">{statuses[item.status]} · {item.message}</p>
        <div className="inline-actions">
          <button onClick={() => void window.bunny.openExternal({ workId: item.workId, kind: "source" }).catch(onError)}>원문 페이지</button>
          <button onClick={() => void window.bunny.openExternal({ workId: item.workId, kind: "doi" }).catch(onError)}>DOI 페이지</button>
          <button disabled={busy || connecting} onClick={() => void connect(item.workId)}>PDF 직접 연결</button>
        </div>
      </li>)}
    </ul>
    {items.length > limit && <button onClick={() => setLimit(value => value + 50)}>남은 문헌 더 보기 · {items.length - limit}편</button>}
  </section>;
}
