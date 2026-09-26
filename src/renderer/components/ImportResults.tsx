import { useState } from "react";
import type { Outputs } from "../../shared/contracts";

export function ImportResults({
  runId,
  busy,
  onResume,
  onError,
}: {
  runId: string;
  busy: boolean;
  onResume: () => Promise<unknown>;
  onError: (error: unknown) => void;
}) {
  const [items, setItems] = useState<Outputs["importItems"] | null>(null);
  const load = async () => {
    try {
      setItems(await window.bunny.importItems({ runId }));
    } catch (error) {
      onError(error);
    }
  };
  return (
    <section className="import-results">
      <button onClick={() => void load()}>
        파일별 결과 {items ? "새로고침" : "보기"}
      </button>
      {items && (
        <>
          <p className="subtle">
            처리 기록 {items.length}건 · 실패{" "}
            {items.filter((i) => i.status === "failed").length}건
          </p>
          <ul>
            {items.slice(-100).map((item, i) => (
              <li key={i}>
                <strong>{item.name}</strong> ·{" "}
                {item.status === "failed" ? "실패" : "완료"} · {item.message}
              </li>
            ))}
          </ul>
          {items.length > 100 && <p className="subtle">최근 100건 표시</p>}
          {items.some((i) => i.status === "failed") && (
            <button
              disabled={busy}
              onClick={() =>
                void onResume()
                  .then(() => setItems(null))
                  .catch(onError)
              }
            >
              실패 파일 재시도
            </button>
          )}
        </>
      )}
    </section>
  );
}
