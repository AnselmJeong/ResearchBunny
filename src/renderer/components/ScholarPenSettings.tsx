import { useCallback, useEffect, useState } from "react";
import { FolderOpen, FolderPlus, Link2, PenLine, RefreshCw, Unlink } from "lucide-react";
import type { Project } from "../../shared/types";
import type { ScholarPenState } from "../../shared/scholarpen";

const NEW_FOLDER = "\u0000new";

/**
 * The ScholarPen shared folder and which project is linked to which of its
 * folders. ResearchBunny writes only into each linked folder's hidden
 * `.researchbunny/` folder; the library stays where it is.
 */
export function ScholarPenSettings({ projects, onProjectCreated, onError }: {
  projects: Project[];
  /** A project made from a folder: the window can switch to it and offer to fetch missing PDFs. */
  onProjectCreated: (project: Project, summary: string, withoutPdf: number) => void | Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [state, setState] = useState<ScholarPenState | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => window.bunny.scholarpenState({}).then(setState).catch(onError), [onError]);
  useEffect(() => void load(), [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
      void load();
    }
  };
  const chooseRoot = () => run(async () => {
    const path = await window.bunny.chooseScholarPenRoot({});
    if (path) setState(await window.bunny.scholarpenConfigure({ root: path }));
  });
  const unlinked = state?.folders.filter((f) => !f.projectId) ?? [];
  return (
    <section id="settings-scholarpen" className="settings-group scholarpen-settings">
      <h3><PenLine size={16} /> ScholarPen 연동</h3>
      <p className="subtle">
        ScholarPen 공유 폴더의 프로젝트 폴더를 ResearchBunny 프로젝트에 연결합니다. 연결하면 그 폴더의 숨김 폴더 <code>.researchbunny/</code>에
        연구 질문·심사 기준(project.json), 아카이브 목록(archive.json), 근거 표(evidence.csv·md)를 씁니다. 라이브러리와 PDF는 옮기지 않으며, 원고와
        references.bib에는 쓰지 않습니다.
      </p>
      <div className="inline-actions">
        <span className="scholarpen-root" title={state?.root ?? undefined}>
          {state?.root ? <>공유 폴더: <code>{state.root}</code>{!state.online && <span className="warning-text"> · 읽을 수 없음</span>}</> : "공유 폴더가 정해지지 않았습니다."}
        </span>
        <button className="secondary" disabled={busy} onClick={() => void chooseRoot()}><FolderOpen size={14} /> {state?.root ? "바꾸기" : "공유 폴더 고르기"}</button>
        {state?.root && <button className="text-button" disabled={busy} onClick={() => void run(async () => setState(await window.bunny.scholarpenConfigure({ root: null })))}>해제</button>}
      </div>
      {state?.root && state.online && (
        <>
          <table className="scholarpen-links">
            <thead><tr><th>ResearchBunny 프로젝트</th><th>연결된 폴더</th><th /></tr></thead>
            <tbody>
              {projects.map((project) => {
                const folder = state.links[project.id];
                const synced = state.synced[project.id];
                return (
                  <tr key={project.id}>
                    <td>{project.name}</td>
                    <td>
                      <select aria-label={`${project.name}에 연결할 폴더`} value={folder ?? ""} disabled={busy}
                        onChange={(e) => {
                          const value = e.target.value;
                          void run(async () => {
                            if (value === NEW_FOLDER) setState(await window.bunny.projectLink({ projectId: project.id, folder: project.name, create: true }));
                            else setState(await window.bunny.projectLink({ projectId: project.id, folder: value || null, create: false }));
                          });
                        }}>
                        <option value="">연결 안 함</option>
                        {state.folders.filter((f) => !f.projectId || f.projectId === project.id).map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                        {!state.folders.some((f) => f.name === project.name) && <option value={NEW_FOLDER}>새 폴더 ‘{project.name}’ 만들어 연결</option>}
                      </select>
                      {synced?.error && <div className="warning-text">{synced.error}</div>}
                    </td>
                    <td>
                      {folder && (
                        <span className="inline-actions">
                          <button className="icon-button" title="지금 쓰기" aria-label={`${project.name} 폴더에 지금 쓰기`} disabled={busy}
                            onClick={() => void run(() => window.bunny.projectSync({ projectId: project.id }))}><RefreshCw size={14} /></button>
                          <button className="icon-button" title="연결 해제" aria-label={`${project.name} 연결 해제`} disabled={busy}
                            onClick={() => void run(async () => setState(await window.bunny.projectLink({ projectId: project.id, folder: null, create: false })))}><Unlink size={14} /></button>
                        </span>
                      )}
                      {synced && !synced.error && <span className="subtle"> {new Date(synced.at).toLocaleTimeString()}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {unlinked.length > 0 && (
            <>
              <h4><Link2 size={14} /> 연결되지 않은 ScholarPen 폴더</h4>
              <ul className="scholarpen-folders">
                {unlinked.map((f) => (
                  <li key={f.name}>
                    <span>{f.name}</span>
                    <span className="subtle">{f.hasReferences ? "references.bib 있음" : "references.bib 없음"}</span>
                    <button className="secondary" disabled={busy} title="이 폴더 이름으로 프로젝트를 만들고 연결합니다. references.bib의 문헌은 아카이브에 담습니다."
                      onClick={() => void run(async () => {
                        const result = await window.bunny.projectFromFolder({ folder: f.name });
                        await onProjectCreated(result.project, `‘${f.name}’ 폴더로 프로젝트를 만들었습니다 · 아카이브 ${result.imported}편${result.failed ? ` · 읽지 못한 항목 ${result.failed}개` : ""}`, result.withoutPdf.length);
                      })}>
                      <FolderPlus size={14} /> 폴더에서 프로젝트 만들기
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
