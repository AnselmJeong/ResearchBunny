import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderInput, LoaderCircle, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { Modal } from "./Modal";
import { SHELF_DUPLICATED, SHELF_UNCATEGORIZED, type ShelfSortItem, type ShelfSortResult, type ShelfSortView } from "../../shared/shelf";

type Choice = { target: string; checked: boolean };
type View = "all" | "review" | "duplicates";
const SPECIAL: Record<string, string> = { [SHELF_UNCATEGORIZED]: "미분류 (_uncategorized)", [SHELF_DUPLICATED]: "중복 (_duplicated)" };
const CONFIDENCE = { high: "AI 확신 높음", medium: "AI 확신 보통", low: "AI 확신 낮음" };
const label = (path: string) => SPECIAL[path] || path.split("/").pop() || path;
const percent = (share: number) => `${Math.round(share * 100)}%`;
/** Worth a second look: neighbours and AI disagree, the AI hesitated, or the AI did not answer. */
const needsReview = (item: ShelfSortItem) => item.source === "embedding" || item.agree === false || item.confidence === "medium";
const initial = (item: ShelfSortItem): Choice => ({
  target: item.target ?? "",
  checked: !!item.target && item.target !== item.folder && item.source !== "embedding",
});

export function ShelfSortDialog({ aiEnabled, onClose, onError, onSettings }: {
  aiEnabled: boolean;
  onClose: () => void;
  onError: (error: unknown) => void;
  onSettings: () => void;
}) {
  const [state, setState] = useState<ShelfSortView | null>(null);
  const [choices, setChoices] = useState<{ createdAt: string | null; map: Record<string, Choice> }>({ createdAt: null, map: {} });
  const [view, setView] = useState<View>("all");
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ShelfSortResult | null>(null);
  const load = useCallback(() => window.bunny.shelfSortState({}).then(setState), []);
  useEffect(() => {
    void load().catch(onError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.bunny.onEvent((event) => {
      if (event.type !== "shelf" && event.type !== "changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load().catch(() => {}), 400);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [load, onError]);
  // A new proposal resets the choices; reloads of the same proposal keep the user's edits.
  useEffect(() => {
    if (!state || state.createdAt === choices.createdAt) return;
    setChoices({ createdAt: state.createdAt, map: Object.fromEntries(state.items.map((item) => [item.fileId, initial(item)])) });
  }, [state, choices.createdAt]);

  const running = state?.job.status === "running";
  const items = useMemo(() => state?.items || [], [state]);
  // Without items left to review, a saved proposal says nothing about today's inbox.
  const open = !!items.length;
  const settled = !!state && !running && !open && (state.job.status === "idle" || state.job.status === "ready");
  const choice = (item: ShelfSortItem) => choices.map[item.fileId] || initial(item);
  const setChoice = (item: ShelfSortItem, next: Partial<Choice>) =>
    setChoices((current) => ({ ...current, map: { ...current.map, [item.fileId]: { ...choice(item), ...next } } }));
  const pick = (item: ShelfSortItem, target: string) => setChoice(item, { target, checked: !!target && target !== item.folder });
  const selected = items.filter((item) => { const c = choice(item); return c.checked && c.target && c.target !== item.folder; });
  const counts = {
    filed: selected.filter((i) => !SPECIAL[choice(i).target]).length,
    uncategorized: selected.filter((i) => choice(i).target === SHELF_UNCATEGORIZED).length,
    duplicated: selected.filter((i) => choice(i).target === SHELF_DUPLICATED).length,
    review: items.filter(needsReview).length,
    duplicates: items.filter((i) => i.source === "duplicate").length,
  };
  const shown = items.filter((item) => view === "all" || (view === "review" ? needsReview(item) : item.source === "duplicate"));
  const domains = useMemo(() => {
    const groups = new Map<string, { path: string; name: string; def: string }[]>();
    for (const leaf of state?.leaves || []) groups.set(leaf.domain || "서고", [...(groups.get(leaf.domain || "서고") || []), leaf]);
    return [...groups];
  }, [state]);

  const start = async () => {
    setResult(null);
    try { setState(await window.bunny.shelfSortStart({})); } catch (error) { onError(error); }
  };
  const apply = async () => {
    if (!selected.length) return;
    setApplying(true);
    try {
      setResult(await window.bunny.shelfSortApply({ items: selected.map((item) => ({ fileId: item.fileId, target: choice(item).target })) }));
      setView("all");
      await load();
    } catch (error) { onError(error); } finally { setApplying(false); }
  };

  return <Modal title="수신함 정리" wide onClose={onClose}>
    <div className="shelf-sort">
      <p className="subtle">
        서고 루트와 _uncategorized의 PDF마다 이미 분류된 비슷한 논문이 있는 폴더를 로컬 임베딩으로 찾고, 설정한 AI가
        {state?.taxonomy === "folders" ? " 서고의 말단 폴더 이름" : " 분류 기준(_system/taxonomy.json)의 포함·배제 규칙"}을 보고 폴더를 고릅니다.
        AI에는 제목과 초록(없으면 PDF 첫 쪽 앞부분)만 보냅니다. 승인한 PDF만 옮기고 파일명은 바꾸지 않습니다.
      </p>
      {!aiEnabled && <p className="warning-text">
        AI 연결이 꺼져 있습니다. <button className="text-button" onClick={onSettings}>설정 열기</button>
      </p>}
      <div className="shelf-sort-status" role="status">
        <span className={state?.job.status === "failed" ? "danger" : settled && !state.inbox ? "green" : ""}>
          {running && <LoaderCircle size={13} className="spin" />}
          {!state ? "" : settled
            ? state.inbox ? `수신함에 PDF ${state.inbox.toLocaleString()}편이 있습니다.` : "✓ 수신함에 정리할 PDF가 없습니다."
            : state.job.message}
        </span>
        {running
          ? <button className="icon-button" title="제안 만들기 취소" aria-label="제안 만들기 취소" onClick={() => void window.bunny.shelfSortCancel({}).catch(onError)}><Square size={14} /></button>
          : <button disabled={!aiEnabled || applying} onClick={() => void start()}>
            <RefreshCw size={14} />{open ? "제안 다시 만들기" : "제안 만들기"}
          </button>}
      </div>
      {result && <div className="shelf-sort-result" role="status">
        <strong>{(result.moved + result.uncategorized + result.duplicated).toLocaleString()}편을 옮겼습니다.</strong>
        <span className="subtle"> 분류 {result.moved} · 미분류 {result.uncategorized} · 중복 {result.duplicated}{result.ledger ? " · move_log.jsonl·intake 로그·index.json 갱신" : ""}</span>
        {!!result.skipped.length && <ul>{result.skipped.map((s) => <li key={s.relPath + s.reason} className="danger">{s.relPath} · {s.reason}</li>)}</ul>}
      </div>}
      {!!state?.waiting.length && !running && <p className="subtle">색인 대기 {state.waiting.length}편은 이번 제안에서 빠졌습니다.</p>}
      {open && !running && !!state?.fresh && <p className="warning-text">
        이 제안 뒤에 수신함에 들어온 PDF {state.fresh.toLocaleString()}편은 제안에 없습니다. 제안을 다시 만들면 함께 다룹니다.
      </p>}
      {!!items.length && !running && <>
        <div className="shelf-sort-toolbar">
          <div className="view-switch" role="tablist" aria-label="제안 보기">
            {([["all", `전체 ${items.length}`], ["review", `확인 권장 ${counts.review}`], ["duplicates", `중복 ${counts.duplicates}`]] as const).map(([key, text]) =>
              <button key={key} role="tab" aria-selected={view === key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{text}</button>)}
          </div>
          <span className="subtle">옮길 논문: 분류 {counts.filed} · 미분류 {counts.uncategorized} · 중복 {counts.duplicated}</span>
        </div>
        {!shown.length && <p className="subtle">이 보기에 해당하는 제안이 없습니다.</p>}
        <ul className="shelf-sort-items">
          {shown.map((item) => {
            const c = choice(item);
            const unchanged = !c.target || c.target === item.folder;
            return <li key={item.fileId} className={needsReview(item) ? "attention" : ""}>
              <input type="checkbox" aria-label={`${item.title} 옮기기`} checked={c.checked && !unchanged} disabled={unchanged}
                onChange={(e) => setChoice(item, { checked: e.target.checked })} />
              <div className="shelf-sort-paper">
                <strong title={item.relPath}>{item.title}</strong>
                <span className="subtle">
                  {[item.year, item.authors.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}
                  {item.folder ? ` · 지금 ${item.folder}` : ""}
                </span>
                <span className="shelf-sort-evidence">
                  {item.source === "ai" && item.confidence && <span className="badge">{CONFIDENCE[item.confidence]}</span>}
                  {item.agree === true && <span className="badge agree">임베딩 1위와 일치</span>}
                  {item.agree === false && <span className="badge warning"><TriangleAlert size={11} />임베딩 1위와 다름</span>}
                  {item.source === "embedding" && <span className="badge warning"><TriangleAlert size={11} />AI 판정 없음</span>}
                  {(item.source === "duplicate" || item.source === "version") && <span className="badge">{item.source === "duplicate" ? "중복" : "다른 판본"}</span>}
                  <span className="subtle">{item.reason}</span>
                </span>
                {item.existing && <span className="subtle" title={item.existing}>기존 사본: {item.existing}</span>}
                {!!item.votes.length && <span className="shelf-sort-votes" aria-label="임베딩 후보">
                  {item.votes.map((vote) => <button key={vote.path} className={`folder-chip ${c.target === vote.path ? "chosen" : ""}`} title={`${vote.path} · 가장 가까운 논문 유사도 ${vote.similarity}`}
                    onClick={() => pick(item, vote.path)}>{label(vote.path)} {percent(vote.share)}</button>)}
                </span>}
              </div>
              <select aria-label={`${item.title} 옮길 폴더`} value={c.target} onChange={(e) => pick(item, e.target.value)}>
                <option value="">그대로 두기</option>
                {domains.map(([domain, leaves]) => <optgroup key={domain} label={domain}>
                  {leaves.map((leaf) => <option key={leaf.path} value={leaf.path} title={leaf.def}>{leaf.name}</option>)}
                </optgroup>)}
                <optgroup label="특수 폴더">
                  {Object.entries(SPECIAL).map(([path, text]) => <option key={path} value={path}>{text}</option>)}
                </optgroup>
              </select>
            </li>;
          })}
        </ul>
      </>}
    </div>
    <div className="modal-footer">
      <button onClick={onClose}>닫기</button>
      <button className="primary" disabled={!selected.length || applying || running} onClick={() => void apply()}>
        {applying ? <LoaderCircle size={14} className="spin" /> : <FolderInput size={14} />}
        {selected.length ? `선택한 ${selected.length}편 옮기기` : "옮길 논문 선택"}
      </button>
    </div>
  </Modal>;
}
