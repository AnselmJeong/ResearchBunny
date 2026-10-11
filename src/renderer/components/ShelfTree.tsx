import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, CircleAlert, Folder, Inbox, LibraryBig, Plus, WifiOff } from "lucide-react";
import { SHELF_ALL, SHELF_INBOX, SHELF_REVIEW, type ShelfFolderNode, type ShelfSummary } from "../../shared/shelf";

const OPEN_KEY = "researchbunny.shelfOpenFolders";
function loadOpen(): string[] {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || "[]"); } catch { return []; }
}
export function shelfJobLabel(shelf: ShelfSummary) {
  const job = shelf.job;
  if (!shelf.online || job.state === "offline") return "오프라인";
  if (job.state === "paused") return "일시정지";
  if (job.state === "confirm") return "확인 필요";
  if ((job.state === "indexing" || job.state === "scanning") && job.total)
    return `색인 ${Math.floor(((job.done || 0) / job.total) * 100)}%`;
  if (job.state === "scanning") return "스캔 중";
  return "";
}

export function ShelfTree({ shelf, scope, scopeId, navigate, onSetup }: {
  shelf: ShelfSummary;
  scope: string;
  scopeId: string;
  navigate: (scope: "shelf", id?: string) => void;
  onSetup: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string[]>(loadOpen);
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(expanded)); } catch { /* Optional view preference. */ } }, [expanded]);
  if (!shelf.configured)
    return <button className="shelf-setup" data-help="이미 정리해 둔 PDF 폴더(예: NAS)를 서고로 연결합니다. 색인은 파일을 바꾸지 않고, 수신함 정리에서 승인한 PDF만 옮깁니다." onClick={onSetup}>
      <LibraryBig size={17} />서고 연결<Plus size={14} />
    </button>;
  const children = new Map<string | null, ShelfFolderNode[]>();
  const ids = new Set(shelf.folders.map((f) => f.id));
  for (const folder of shelf.folders) {
    const parent = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
    children.set(parent, [...(children.get(parent) || []), folder]);
  }
  const active = (id: string) => scope === "shelf" && scopeId === id;
  const status = shelfJobLabel(shelf);
  const Chevron = open ? ChevronDown : ChevronRight;
  const branch = (folder: ShelfFolderNode, depth: number) => {
    const kids = children.get(folder.id) || [];
    const isOpen = expanded.includes(folder.id);
    const Toggle = isOpen ? ChevronDown : ChevronRight;
    return <div key={folder.id} className="shelf-branch" style={{ ["--depth" as string]: depth }}>
      <div className={`shelf-folder ${active(folder.id) ? "active" : ""}`}>
        {kids.length ? <button className="icon-button" aria-label={isOpen ? `${folder.name} 접기` : `${folder.name} 펼치기`} aria-expanded={isOpen}
          onClick={() => setExpanded((list) => isOpen ? list.filter((id) => id !== folder.id) : [...list, folder.id])}><Toggle size={13} /></button> : <span className="shelf-spacer" />}
        <button aria-current={active(folder.id) ? "page" : undefined} title={folder.relPath} onClick={() => navigate("shelf", folder.id)}>
          <Folder size={15} /><span className="topic-name">{folder.name}</span><span className="nav-count">{folder.count.toLocaleString()}</span>
        </button>
      </div>
      {isOpen && kids.map((kid) => branch(kid, depth + 1))}
    </div>;
  };
  return <div className="archive-tree shelf-tree">
    <div className={`archive-root ${active(SHELF_ALL) ? "active" : ""}`}>
      <button className="icon-button" aria-label={open ? "서고 접기" : "서고 펼치기"} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron size={14} />
      </button>
      <button aria-current={active(SHELF_ALL) ? "page" : undefined} title={shelf.root?.path}
        data-help="앱 밖에서 정리한 서고 PDF입니다. 프로젝트에 저장하지 않아도 열람·추천·검색에 쓰입니다." onClick={() => navigate("shelf", SHELF_ALL)}>
        <LibraryBig size={17} /><span>서고</span>
        {status ? <span className={`shelf-status ${!shelf.online ? "offline" : ""}`}>{!shelf.online && <WifiOff size={11} />}{status}</span>
          : <span className="nav-count">{shelf.total.toLocaleString()}</span>}
      </button>
    </div>
    {open && <div className="archive-branches shelf-branches" aria-label="서고 폴더">
      {shelf.inbox > 0 && <button className={active(SHELF_INBOX) ? "active" : ""} aria-current={active(SHELF_INBOX) ? "page" : undefined}
        data-help="서고 루트와 _uncategorized에 있는, 아직 폴더를 정하지 않은 PDF입니다. 목록 위의 수신함 정리로 폴더를 제안받고 옮길 수 있습니다." onClick={() => navigate("shelf", SHELF_INBOX)}>
        <Inbox size={15} /><span className="topic-name">수신함</span><span className="nav-count">{shelf.inbox.toLocaleString()}</span>
      </button>}
      {(children.get(null) || []).map((folder) => branch(folder, 0))}
      {shelf.review > 0 && <button className={active(SHELF_REVIEW) ? "active" : ""} aria-current={active(SHELF_REVIEW) ? "page" : undefined}
        data-help="서지를 자동으로 확인하지 못했거나 후보가 애매한 PDF입니다. 문헌 상세의 발견 근거에서 확인하세요." onClick={() => navigate("shelf", SHELF_REVIEW)}>
        <CircleAlert size={15} /><span className="topic-name">확인 필요</span><span className="nav-count">{shelf.review.toLocaleString()}</span>
      </button>}
    </div>}
  </div>;
}
