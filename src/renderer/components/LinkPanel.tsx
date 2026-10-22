import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Bookmark, Check, ChevronLeft, ChevronRight, LoaderCircle, X } from "lucide-react";
import type { Collection, LinkGroup, LinkMode, LinkedWork, WorkLinks, WorkView } from "../../shared/types";

export const LINK_LABELS: Record<LinkMode, string> = {
  related: "관련 논문",
  references: "참고문헌",
  citedBy: "후속 인용",
};
const SUBTITLES: Record<LinkMode, string> = {
  related: "이 논문과 비슷한 논문",
  references: "이 논문이 인용한 연구",
  citedBy: "이 논문을 인용한 연구",
};
const NEW_COLLECTION = "new";
type Sort = "citations" | "year";
type Loaded = WorkLinks & { key: string };
/** What the list looked like when the user opened one of its papers, so 뒤로 shows it again. */
export interface LinkStash {
  sort: Sort;
  otherFolders: boolean;
  loaded: Loaded;
  expanded: string | null;
  scroll: number;
}
/** "Lodge, Daniel J" and "Daniel J. Lodge" both give Lodge. */
const surname = (name: string) => (name.includes(",") ? name.split(",")[0].trim() : name.trim().split(/\s+/).at(-1)) || name;

/** One paper's references, citing papers or related papers, listed inside the inspector. */
export function LinkPanel({ projectId, work, mode, collections, restore, visited, onClose, onOpen, onDiscover, onNotice, onError }: {
  projectId: string;
  work: WorkView;
  mode: LinkMode;
  collections: Collection[];
  /** The list as it was before the user opened `visited`. */
  restore?: LinkStash;
  visited?: string;
  onClose: () => void;
  onOpen: (id: string, stash: LinkStash) => void;
  onDiscover: () => void;
  onNotice: (text: string) => void;
  onError: (error: unknown) => void;
}) {
  const [sort, setSort] = useState<Sort>(restore?.sort ?? "citations");
  const [otherFolders, setOtherFolders] = useState(restore?.otherFolders ?? false);
  const [loaded, setLoaded] = useState<Loaded | null>(restore?.loaded ?? null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [paging, setPaging] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(restore?.expanded ?? null);
  const [details, setDetails] = useState<Record<string, WorkView>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const anchor = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const key = `${projectId}:${work.id}:${mode}:${sort}:${otherFolders}`;
  useEffect(() => {
    if (loaded?.key === key) return;
    let valid = true;
    setError(null);
    void window.bunny.workLinks({ projectId, workId: work.id, mode, sort, otherFolders })
      .then((result) => { if (valid) setLoaded({ ...result, key }); })
      .catch((e) => { if (valid) setError(e instanceof Error ? e.message : String(e)); });
    return () => { valid = false; };
  }, [key, attempt]);
  // Coming back from a paper: same scroll, and that paper's badges as they are now.
  useLayoutEffect(() => {
    const scroller = root.current?.closest(".inspector-scroll");
    if (scroller) scroller.scrollTop = restore?.scroll ?? 0;
  }, []);
  useEffect(() => {
    if (!visited) return;
    void window.bunny.inspect({ projectId, workId: visited })
      .then((w) => patchItems([w.id], { screening: w.state.screening, shelf: w.shelf?.folder ?? null }))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!expanded || details[expanded]) return;
    let valid = true;
    void window.bunny.inspect({ projectId, workId: expanded })
      .then((w) => { if (valid) setDetails((d) => ({ ...d, [w.id]: w })); })
      .catch(onError);
    return () => { valid = false; };
  }, [expanded]);
  const patchItems = (ids: string[], patch: Partial<LinkedWork>) => {
    const set = new Set(ids);
    setLoaded((current) => current && {
      ...current,
      groups: current.groups.map((g) => ({ ...g, items: g.items.map((w) => (set.has(w.id) ? { ...w, ...patch } : w)) })),
    });
  };
  const current = loaded?.key === key ? loaded : null;
  // Shown while a new sort loads, dimmed; never another paper's list, since the panel remounts per paper.
  const shown = current || loaded;
  const flat = shown?.groups.flatMap((g) => g.items) || [];
  const selectedSet = new Set(selected);
  const toggle = (index: number, range: boolean) => {
    const id = flat[index].id;
    // Read the anchor now: the updater may run after the next toggle has moved it.
    const last = anchor.current;
    anchor.current = index;
    setSelected((prev) => {
      const next = new Set(prev);
      if (range && last !== null) {
        for (const w of flat.slice(Math.min(last, index), Math.max(last, index) + 1)) next.add(w.id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return [...next];
    });
  };
  const save = (ids: string[]) => {
    if (busy || !ids.length) return;
    setBusy(true);
    void window.bunny.mutateWorks({ projectId, ids, patch: { screening: "included" } })
      .then(() => {
        patchItems(ids, { screening: "included" });
        setSelected((s) => s.filter((id) => !ids.includes(id)));
        onNotice(`${ids.length}편을 아카이브에 저장했습니다.`);
      })
      .catch(onError)
      .finally(() => setBusy(false));
  };
  const collect = (target: string, name?: string) => {
    const ids = [...selected];
    const existing = collections.find((c) => c.id === target);
    if (busy || !ids.length || (!existing && !name?.trim())) return;
    setBusy(true);
    void (async () => {
      const collection = existing || await window.bunny.createCollection({ projectId, name: name!.trim() });
      setNewName(null);
      await window.bunny.collectionMembers({ projectId, collectionId: collection.id, ids });
      patchItems(ids, { screening: "included" });
      setSelected([]);
      onNotice(`'${collection.name}'에 ${ids.length}편을 저장했습니다. 아카이브에도 저장됩니다.`);
    })().catch(onError).finally(() => setBusy(false));
  };
  const more = (group: LinkGroup) => {
    if (!group.cursor || paging || !current) return;
    setPaging(true);
    void window.bunny.workLinks({ projectId, workId: work.id, mode, sort, otherFolders, cursor: group.cursor })
      .then((page) => {
        const next = page.groups.find((g) => g.key === group.key);
        if (!next) return;
        setLoaded((l) => {
          if (!l || l.key !== key) return l;
          const have = new Set(l.groups.flatMap((g) => g.items.map((w) => w.id)));
          return {
            ...l,
            groups: l.groups.map((g) => g.key === group.key
              ? { ...g, items: [...g.items, ...next.items.filter((w) => !have.has(w.id))], cursor: next.cursor }
              : g),
          };
        });
      })
      .catch(onError)
      .finally(() => setPaging(false));
  };
  const open = (id: string) => {
    if (!current) return;
    const scroller = root.current?.closest(".inspector-scroll");
    onOpen(id, { sort, otherFolders, loaded: current, expanded, scroll: scroller?.scrollTop ?? 0 });
  };
  const total = mode === "references"
    ? shown?.groups[0]?.total
    : mode === "citedBy"
      ? shown?.groups.find((g) => g.key === "citing")?.total
      : flat.length;
  const author = work.authors[0] ? `${surname(work.authors[0])}${work.authors.length > 1 ? " 외" : ""}` : "저자 미상";
  return <div className="link-panel" ref={root}>
    <header className="link-head">
      <button className="link-back" onClick={onClose} title="논문 상세로 돌아갑니다">
        <ChevronLeft size={14} />상세
      </button>
      <div className="link-parent">
        <span className="link-kicker">
          {LINK_LABELS[mode]}
          {typeof total === "number" && <strong>{total.toLocaleString()}편</strong>}
        </span>
        <p title={work.title}>{work.title}</p>
        <small>{SUBTITLES[mode]} · {author} {work.year || "연도 미상"}</small>
      </div>
    </header>
    <div className="link-controls">
      <label className="check">
        <input
          type="checkbox"
          checked={flat.length > 0 && flat.every((w) => selectedSet.has(w.id))}
          disabled={!flat.length}
          onChange={(e) => setSelected(e.target.checked ? flat.map((w) => w.id) : [])}
        />
        모두 선택
      </label>
      {mode !== "related" && (
        <div className="link-sort" role="group" aria-label="목록 정렬">
          {([["citations", "피인용순"], ["year", "최신순"]] as const).map(([value, label]) => (
            <button key={value} aria-pressed={sort === value} onClick={() => setSort(value)}>{label}</button>
          ))}
        </div>
      )}
      <button
        className="text-button link-explore"
        data-help={mode === "related"
          ? "초기 관심 기준으로 순위를 매기는 관련 논문 탐색을 실행해 가운데 목록에 엽니다. 결과는 검토 대기함에 들어갑니다."
          : "필터·그래프·추가 조회를 쓸 수 있는 문헌 탐색으로 가운데 목록에 엽니다. 결과는 검토 대기함에 들어갑니다."}
        onClick={onDiscover}
      >
        탐색으로 열기<ArrowUpRight size={12} />
      </button>
    </div>
    {error && !current && (
      <div className="link-error">
        <p className="warning-text">{error}</p>
        <button onClick={() => setAttempt((n) => n + 1)}>다시 시도</button>
      </div>
    )}
    {!shown && !error && <p className="subtle related-loading"><LoaderCircle size={14} className="spin" /> 불러오는 중…</p>}
    {shown && (
      <div className={current ? "link-groups" : "link-groups stale"} aria-busy={!current}>
        {shown.notices.map((notice) => <p key={notice} className="subtle">{notice}</p>)}
        {shown.groups.map((group) => {
          const offset = flat.indexOf(group.items[0]);
          return (
            <section key={group.key} className="link-group">
              <div className="note-heading">
                <h3>
                  {group.label}
                  <span className="link-count">
                    {group.total !== null && group.total > group.items.length
                      ? `${group.items.length} / ${group.total.toLocaleString()}편`
                      : `${group.items.length}편`}
                  </span>
                </h3>
                {group.key === "shelf" && work.shelf && (
                  <label className="check"><input type="checkbox" checked={otherFolders} onChange={(e) => setOtherFolders(e.target.checked)} />다른 폴더만</label>
                )}
              </div>
              {group.note && <p className="subtle">{group.note}</p>}
              {!group.items.length && <p className="subtle">표시할 논문이 없습니다.</p>}
              <ul>
                {group.items.map((item, i) => (
                  <Row
                    key={item.id}
                    item={item}
                    similarity={group.key === "shelf" || group.key === "pubmed"}
                    selected={selectedSet.has(item.id)}
                    expanded={expanded === item.id}
                    detail={details[item.id]}
                    busy={busy}
                    onToggle={(range) => toggle(offset + i, range)}
                    onExpand={() => setExpanded((id) => (id === item.id ? null : item.id))}
                    onSave={() => save([item.id])}
                    onOpen={() => open(item.id)}
                    onDoi={() => void window.bunny.openExternal({ workId: item.id, kind: "doi" }).catch(onError)}
                  />
                ))}
              </ul>
              {group.cursor && (
                <button className="text-button link-more" disabled={paging} onClick={() => more(group)}>
                  {paging ? <LoaderCircle size={12} className="spin" /> : null}
                  {paging ? "불러오는 중…" : "50편 더 보기"}
                </button>
              )}
            </section>
          );
        })}
      </div>
    )}
    {selected.length > 0 && (
      <div className="link-actions" role="toolbar" aria-label="선택한 문헌 작업">
        <div className="link-actions-row">
          <strong>{selected.length}편 선택</strong>
          <button className="icon-button" title="선택 해제" aria-label="선택 해제" onClick={() => { setSelected([]); setNewName(null); }}>
            <X size={14} />
          </button>
        </div>
        <div className="link-actions-row">
          <button className="save-inspector" disabled={busy} onClick={() => save(selected)}>
            <Bookmark size={14} />아카이브에 저장
          </button>
          <select
            aria-label="선택한 문헌을 컬렉션에 저장"
            value=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value === NEW_COLLECTION)
                setNewName(`${work.authors[0] ? surname(work.authors[0]) : "논문"} ${work.year || ""} ${LINK_LABELS[mode]}`.replace(/\s+/g, " "));
              else if (e.target.value) collect(e.target.value);
            }}
          >
            <option value="">컬렉션에 저장…</option>
            {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW_COLLECTION}>+ 새 컬렉션 만들기…</option>
          </select>
        </div>
        {newName !== null && (
          <form className="link-actions-row" onSubmit={(e) => { e.preventDefault(); collect(NEW_COLLECTION, newName); }}>
            <input autoFocus aria-label="새 컬렉션 이름" maxLength={160} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" disabled={busy || !newName.trim()}>만들고 저장</button>
          </form>
        )}
      </div>
    )}
  </div>;
}

function Row({ item, similarity, selected, expanded, detail, busy, onToggle, onExpand, onSave, onOpen, onDoi }: {
  item: LinkedWork;
  similarity: boolean;
  selected: boolean;
  expanded: boolean;
  detail?: WorkView;
  busy: boolean;
  onToggle: (range: boolean) => void;
  onExpand: () => void;
  onSave: () => void;
  onOpen: () => void;
  onDoi: () => void;
}) {
  const author = item.authors[0] ? `${surname(item.authors[0])}${item.authorCount > 1 ? " 외" : ""}` : "저자 미상";
  return <li
    className={`link-row${selected ? " selected" : ""}${expanded ? " expanded" : ""}`}
    // Right-click toggles the row's selection, as in the list (shift selects a range).
    onContextMenu={(e) => { e.preventDefault(); onToggle(e.shiftKey); }}
  >
    <input type="checkbox" aria-label={`${item.title} 선택`} checked={selected} onChange={(e) => onToggle((e.nativeEvent as MouseEvent).shiftKey)} />
    <button className="link-main" aria-expanded={expanded} title="클릭하면 펼치기 · 오른쪽 클릭하면 선택" onClick={onExpand}>
      <span className="link-title">{item.title}</span>
      <span className="link-meta">
        {similarity && item.score !== null && (
          <span className="similarity" aria-label={`유사도 ${item.score.toFixed(2)}`}>
            <span style={{ width: `${Math.max(4, Math.min(100, (item.score - 0.5) * 200))}%` }} />
          </span>
        )}
        <span>{item.year || "연도 미상"}</span>
        <span>{author}</span>
        {item.citations !== null && <span>피인용 {item.citations.toLocaleString()}</span>}
        {item.screening === "included" && <span className="link-badge saved"><Check size={10} strokeWidth={3} />아카이브</span>}
        {item.screening === "excluded" && <span className="link-badge">제외</span>}
        {item.screening === "trash" && <span className="link-badge">휴지통</span>}
        {item.shelf && <span className="folder-chip" title={item.shelf}>{item.shelf.split("/").pop()}</span>}
      </span>
    </button>
    {expanded && (
      <div className="link-detail">
        {!detail ? (
          <p className="subtle related-loading"><LoaderCircle size={13} className="spin" /> 불러오는 중…</p>
        ) : (
          <>
            <p className="link-authors">{detail.authors.join(" · ") || "저자 미상"}</p>
            {detail.venue && <p className="subtle">{detail.venue}</p>}
            {detail.abstract
              ? <p className="link-abstract">{detail.abstract}</p>
              : <p className="subtle">제공된 초록이 없습니다.</p>}
          </>
        )}
        <div className="inline-actions">
          {item.screening === "included"
            ? <span className="link-badge saved"><Check size={11} strokeWidth={3} />아카이브 저장됨</span>
            : <button disabled={busy} onClick={onSave}><Bookmark size={13} />아카이브에 저장</button>}
          {item.doi && <button onClick={onDoi}>DOI<ArrowUpRight size={12} /></button>}
          <button className="link-open" onClick={onOpen}>이 논문 보기<ChevronRight size={13} /></button>
        </div>
      </div>
    )}
  </li>;
}
