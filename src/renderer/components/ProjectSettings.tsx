import { useEffect, useState } from "react";
import { Check, FolderKanban, Pencil, Trash2, X } from "lucide-react";
import type { Project, ProjectStats } from "../../shared/types";
import { Modal } from "./Modal";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function ProjectSettings({ projects, projectId, onRename, onDelete }: {
  /** Most recently opened first. */
  projects: Project[];
  projectId: string;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [stats, setStats] = useState<Record<string, ProjectStats>>({});
  const [editing, setEditing] = useState<{ id: string; name: string; error: string } | null>(null);
  const [deleting, setDeleting] = useState<{ project: Project; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = projects.map((p) => p.id).join();
  useEffect(() => {
    let valid = true;
    void window.bunny.projectStats({}).then((next) => { if (valid) setStats(next); }).catch(() => {});
    return () => { valid = false; };
  }, [ids]);
  const rename = async () => {
    if (!editing || busy) return;
    const name = editing.name.trim();
    if (!name) return;
    if (name === projects.find((p) => p.id === editing.id)?.name) return setEditing(null);
    setBusy(true);
    try {
      await onRename(editing.id, name);
      setEditing(null);
    } catch (cause) {
      setEditing({ ...editing, error: message(cause) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await onDelete(deleting.project.id);
      setDeleting(null);
    } catch (cause) {
      setDeleting({ ...deleting, error: message(cause) });
    } finally {
      setBusy(false);
    }
  };
  const only = projects.length < 2;
  const target = deleting && stats[deleting.project.id];
  const next = deleting && projects.find((p) => p.id !== deleting.project.id);
  return <section id="settings-projects" className="settings-group project-settings">
    <h3><FolderKanban size={16} /> 프로젝트</h3>
    <p className="subtle">최근에 연 프로젝트가 위에 옵니다. 앱을 다시 열면 맨 위 프로젝트로 시작합니다.</p>
    <ul className="project-manage-list">
      {projects.map((project) => {
        const count = stats[project.id];
        const current = project.id === projectId;
        if (editing?.id === project.id) return <li key={project.id}>
          <form className="project-rename" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
            <input aria-label="프로젝트 이름" value={editing.name} maxLength={160} required autoFocus disabled={busy}
              onChange={(event) => setEditing({ ...editing, name: event.target.value, error: "" })}
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); } }} />
            <button type="submit" className="icon-button" aria-label="이름 저장" title="이름 저장"
              disabled={busy || !editing.name.trim()}><Check size={16} /></button>
            <button type="button" className="icon-button" aria-label="이름 바꾸기 취소" title="취소"
              disabled={busy} onClick={() => setEditing(null)}><X size={16} /></button>
          </form>
          {editing.error && <p className="project-error" role="alert">{editing.error}</p>}
        </li>;
        return <li key={project.id}>
          <div className="project-manage-copy">
            <strong title={project.name}>{project.name}</strong>
            {current && <span className="badge">현재</span>}
            <span className="subtle">
              {count ? `아카이브 ${count.archive.toLocaleString()}편 · 컬렉션 ${count.collections.toLocaleString()}개 · ` : ""}
              {new Date(project.createdAt).toLocaleDateString()} 만듦
            </span>
          </div>
          <div className="project-manage-actions">
            <button className="icon-button" aria-label={`${project.name} 이름 바꾸기`} title="이름 바꾸기" disabled={busy}
              onClick={() => setEditing({ id: project.id, name: project.name, error: "" })}><Pencil size={15} /></button>
            <button className="icon-button project-delete" aria-label={`${project.name} 삭제`}
              title={only ? "프로젝트가 하나뿐이라 삭제할 수 없습니다." : "프로젝트 삭제"} disabled={busy || only}
              onClick={() => setDeleting({ project, error: "" })}><Trash2 size={15} /></button>
          </div>
        </li>;
      })}
    </ul>
    {deleting && <Modal title="프로젝트 삭제" onClose={() => { if (!busy) setDeleting(null); }}>
      <div className="project-delete-body">
        <p>‘{deleting.project.name}’ 프로젝트를 삭제합니다. 복원하거나 실행 취소할 수 없습니다.</p>
        <ul className="project-delete-scope">
          {target && <li>{target.entries
            ? `문헌 ${target.entries.toLocaleString()}편의 상태·메모·태그 (아카이브 ${target.archive.toLocaleString()}편 포함)`
            : "프로젝트에 담긴 문헌 없음"}</li>}
          {!!target?.collections && <li>컬렉션 {target.collections.toLocaleString()}개</li>}
          {!!target?.runs && <li>탐색·가져오기·원문 확보 기록 {target.runs.toLocaleString()}개</li>}
          {!!target?.chats && <li>AI 대화 {target.chats.toLocaleString()}개</li>}
          <li>초기 관심 문헌, 자동 분류 주제, 저장된 화면</li>
        </ul>
        {deleting.project.id === projectId && next && <p>지금 열려 있는 프로젝트입니다. 삭제하면 ‘{next.name}’ 프로젝트로 전환합니다.</p>}
        <p className="subtle">서고 PDF를 포함해 PDF 파일은 지우지 않습니다. 다른 프로젝트나 서고에 있는 문헌도 그대로 남습니다.</p>
        {deleting.error && <p className="project-error" role="alert">{deleting.error}</p>}
      </div>
      <footer className="modal-footer">
        <button disabled={busy} onClick={() => setDeleting(null)}>취소</button>
        <button className="danger" disabled={busy} onClick={() => void remove()}>{busy ? "삭제 중…" : "프로젝트 삭제"}</button>
      </footer>
    </Modal>}
  </section>;
}
