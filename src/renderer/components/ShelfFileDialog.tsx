import { useEffect, useMemo, useState } from "react";
import { FolderOutput, FolderPlus, LoaderCircle, Sparkles } from "lucide-react";
import { Modal } from "./Modal";
import { leafNameProblem, leafPath, type ShelfLeafList, type ShelfNewLeaf, type ShelfSortResult } from "../../shared/shelf";

// Filing by hand: the user picks a leaf (or names a new one) and the papers move
// there with no AI decision. Shared by the 미분류 list and the 수신함 정리 window.

export type LeafDraft = ShelfNewLeaf;
export const blankLeaf = (domain = ""): LeafDraft => ({ domain, name: "", def: "" });
/** What the service receives: the trimmed name and a one-line definition. */
export const toNewLeaf = (draft: LeafDraft): ShelfNewLeaf =>
  ({ domain: draft.domain, name: draft.name.trim(), def: draft.def.replace(/\s+/g, " ").trim() });
/** The service checks again against the disk; this catches what the list already shows. */
export const newLeafProblem = (list: ShelfLeafList, draft: LeafDraft, pending: ShelfNewLeaf[] = []) =>
  leafNameProblem(draft.name.trim(), [
    ...(list.domains.find((d) => d.name === draft.domain)?.leaves.map((l) => l.name) || []),
    ...pending.filter((p) => p.domain === draft.domain).map((p) => p.name),
  ]);
const domainLabel = (name: string) => name || "서고 최상위";

export function NewLeafFields({ list, value, onChange, pending, papers, aiEnabled, onError }: {
  list: ShelfLeafList;
  value: LeafDraft;
  onChange: (next: LeafDraft) => void;
  /** New leaves already planned in this window: their names are taken too. */
  pending?: ShelfNewLeaf[];
  /** The papers the AI draft reads. */
  papers: { workIds?: string[]; fileIds?: string[] };
  aiEnabled: boolean;
  onError: (error: unknown) => void;
}) {
  const [drafting, setDrafting] = useState(false);
  const name = value.name.trim();
  const problem = newLeafProblem(list, value, pending);
  const draft = async () => {
    setDrafting(true);
    try {
      const { def } = await window.bunny.shelfLeafDraft({ ...papers, domain: value.domain, name });
      onChange({ ...value, def });
    } catch (error) { onError(error); } finally { setDrafting(false); }
  };
  return <div className="shelf-new-leaf">
    <div className="form-grid">
      <label className="field">
        {list.taxonomy === "file" ? "도메인" : "상위 폴더"}
        <select value={value.domain} onChange={(e) => onChange({ ...value, domain: e.target.value })}>
          {list.domains.map((d) => <option key={d.name} value={d.name}>{domainLabel(d.name)}</option>)}
        </select>
      </label>
      <label className="field">
        새 폴더 이름
        <input value={value.name} autoFocus maxLength={160} placeholder="예: Sleep & Memory" aria-invalid={!!name && !!problem}
          onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </label>
    </div>
    {!!name && problem && <p className="danger shelf-new-leaf-problem" role="alert">{problem}</p>}
    <label className="field">
      정의 (한 줄, 비워 두어도 됩니다)
      <span className="input-pair">
        <input value={value.def} maxLength={300} placeholder="이 폴더에 들어갈 논문을 한 줄로 설명합니다."
          onChange={(e) => onChange({ ...value, def: e.target.value })} />
        <button type="button" disabled={!aiEnabled || !!problem || drafting}
          data-help={aiEnabled ? "보낼 논문의 제목과 초록, 같은 도메인 폴더들의 정의를 AI에 보내 정의 초안을 받습니다. 받은 초안은 고쳐 쓸 수 있습니다." : "설정에서 AI를 켜면 정의 초안을 받을 수 있습니다."}
          onClick={() => void draft()}>
          {drafting ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}AI 초안
        </button>
      </span>
    </label>
    <p className="subtle">
      {list.taxonomy === "file"
        ? "옮길 때 서고에 폴더를 만들고 _system/taxonomy.json의 그 도메인 끝에 추가합니다. 항목은 intake.py addleaf와 같고 포함·배제 규칙은 비워 둡니다."
        : "옮길 때 서고에 폴더를 만듭니다."}
    </p>
  </div>;
}

export function ShelfFileDialog({ papers, aiEnabled, onClose, onError, onFiled }: {
  /** The chosen 미분류 papers; titles are known for those on the current page. */
  papers: { id: string; title?: string }[];
  aiEnabled: boolean;
  onClose: () => void;
  onError: (error: unknown) => void;
  /** Everything moved: the caller closes the window and says so. */
  onFiled: (result: ShelfSortResult, folder: string) => void;
}) {
  const [list, setList] = useState<ShelfLeafList | null>(null);
  const [target, setTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [leaf, setLeaf] = useState<LeafDraft>(blankLeaf());
  const [query, setQuery] = useState("");
  const [moving, setMoving] = useState(false);
  const [result, setResult] = useState<ShelfSortResult | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const workIds = useMemo(() => papers.map((p) => p.id), [papers]);
  useEffect(() => {
    window.bunny.shelfLeaves({}).then((next) => {
      setList(next);
      setLeaf((current) => current.domain ? current : blankLeaf(next.domains[0]?.name ?? ""));
    }).catch((error) => { setUnreadable(true); onError(error); });
  }, [onError]);

  const needle = query.trim().toLowerCase();
  const shown = (list?.domains || []).map((d) => ({
    ...d,
    leaves: d.leaves.filter((l) => !needle || `${d.name} ${l.name} ${l.def}`.toLowerCase().includes(needle)),
  })).filter((d) => d.leaves.length);
  const problem = list && creating ? newLeafProblem(list, leaf) : null;
  const ready = creating ? !problem : !!target;
  const titled = papers.filter((p) => p.title);
  const send = async () => {
    if (!ready) return;
    setMoving(true);
    try {
      const folder = creating ? leafPath(toNewLeaf(leaf)) : target;
      const next = await window.bunny.shelfFileInto(creating ? { workIds, create: toNewLeaf(leaf) } : { workIds, target });
      if (!next.skipped.length) { onFiled(next, folder); return; }
      setResult(next);
    } catch (error) { onError(error); } finally { setMoving(false); }
  };

  return <Modal title="폴더로 보내기" onClose={onClose}>
    <div className="shelf-file">
      <p className="subtle">
        고른 폴더로 바로 옮깁니다. AI는 판정하지 않습니다. 파일명은 그대로이고, 같은 이름이 있으면 이름 뒤에 (2)를 붙입니다.
        서고에 _system 폴더가 있으면 수신함 정리처럼 move_log.jsonl, intake 로그, index.json에 기록합니다.
      </p>
      <div className="shelf-file-papers">
        <strong>미분류 논문 {papers.length.toLocaleString()}편</strong>
        {!!titled.length && <ul>
          {titled.slice(0, 3).map((p) => <li key={p.id}>{p.title}</li>)}
          {papers.length > 3 && <li className="subtle">외 {(papers.length - Math.min(3, titled.length)).toLocaleString()}편</li>}
        </ul>}
      </div>
      {result ? <div className="shelf-sort-result" role="status">
        <strong>{result.moved.toLocaleString()}편을 옮겼습니다.</strong>
        <span className="subtle">{result.created?.length ? ` 새 폴더 ${result.created.join(", ")}를 만들었습니다.` : ""}{result.ledger ? " move_log.jsonl·intake 로그·index.json 갱신" : ""}</span>
        <ul>{result.skipped.map((s) => <li key={s.relPath + s.reason} className="danger">{s.relPath} · {s.reason}</li>)}</ul>
      </div> : !list ? <p className={unreadable ? "danger" : "subtle"}>
        {unreadable ? "폴더 목록을 읽지 못했습니다. 서고 연결을 확인하세요." : <><LoaderCircle size={13} className="spin" /> 폴더 목록을 읽고 있습니다.</>}
      </p> : <>
        <div className="shelf-file-choose">
          <input type="search" aria-label="폴더 찾기" placeholder="폴더 찾기" value={query} disabled={creating} onChange={(e) => setQuery(e.target.value)} />
          <label className={`check shelf-file-new ${creating ? "chosen" : ""}`}>
            <input type="radio" name="shelf-file-target" checked={creating} onChange={() => setCreating(true)} />
            <FolderPlus size={14} />새 폴더 만들기
          </label>
        </div>
        {creating
          ? <NewLeafFields list={list} value={leaf} onChange={setLeaf} papers={{ workIds }} aiEnabled={aiEnabled} onError={onError} />
          : <div className="shelf-file-leaves" role="radiogroup" aria-label="옮길 폴더">
            {!shown.length && <p className="subtle">{needle ? "찾는 폴더가 없습니다. 새 폴더를 만들 수 있습니다." : "분류 폴더가 없습니다."}</p>}
            {shown.map((d) => <fieldset key={d.name}>
              <legend>{domainLabel(d.name)}</legend>
              {d.leaves.map((l) => <label key={l.path} className={`shelf-file-leaf ${target === l.path ? "chosen" : ""}`} title={l.missing ? "taxonomy.json에는 있지만 서고에 이 폴더가 없습니다. 손으로 이름을 바꿨거나 지웠다면 taxonomy.json도 고치세요." : l.path}>
                <input type="radio" name="shelf-file-target" value={l.path} checked={target === l.path} disabled={l.missing} onChange={() => setTarget(l.path)} />
                <span>
                  <strong>{l.name}</strong>
                  {l.def && <span className="subtle">{l.def}</span>}
                </span>
                {l.missing && <span className="badge warning">서고에 없음</span>}
              </label>)}
            </fieldset>)}
          </div>}
        {creating && <button type="button" className="text-button" onClick={() => setCreating(false)}>기존 폴더에서 고르기</button>}
      </>}
    </div>
    <div className="modal-footer">
      <button onClick={onClose}>{result ? "닫기" : "취소"}</button>
      {!result && <button className="primary" disabled={!list || !ready || moving} onClick={() => void send()}>
        {moving ? <LoaderCircle size={14} className="spin" /> : <FolderOutput size={14} />}
        {creating ? `새 폴더로 ${papers.length.toLocaleString()}편 보내기` : `${papers.length.toLocaleString()}편 보내기`}
      </button>}
    </div>
  </Modal>;
}
