import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Plus } from "lucide-react";
import type { Project } from "../../shared/types";

export function ProjectSwitcher({ projects, projectId, onSelect, onCreate }: {
  projects: Project[];
  projectId: string;
  onSelect: (id: string) => Promise<void>;
  onCreate: (name: string, question: string) => Promise<void>;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = projects.find(project => project.id === projectId);

  useLayoutEffect(() => {
    if (!open || busy) return;
    if (creating) nameInput.current?.focus();
    else popover.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="menuitem"]')?.focus();
  }, [open, creating, busy]);

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current!;
    const panel = popover.current!;
    const position = () => {
      const rect = button.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, creating ? 320 : 280), window.innerWidth - 24);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
      panel.style.maxHeight = `${window.innerHeight - 24}px`;
      panel.style.top = `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - panel.offsetHeight - 12))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(button);
    observer.observe(panel);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [open, creating]);

  const close = () => {
    popover.current?.hidePopover();
    setOpen(false);
    trigger.current?.focus();
  };
  const run = async (action: () => Promise<void>, resetDraft = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      if (resetDraft) {
        setName("");
        setQuestion("");
        setCreating(false);
      }
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return <div className="project-switch">
    <button ref={trigger} type="button" className="project-trigger"
      popoverTarget={id} aria-haspopup={creating ? "dialog" : "menu"}
      aria-expanded={open} aria-controls={id} aria-label={`프로젝트: ${current?.name || "선택"}`}
      onClick={event => {
        event.preventDefault();
        const panel = popover.current!;
        const opening = !panel.matches(":popover-open");
        panel.togglePopover(opening);
        setOpen(opening);
      }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          popover.current?.showPopover();
          setOpen(true);
        }
      }}>
      <span className="project-trigger-copy">
        <span className="project-label">프로젝트</span>
        <span className="project-name" title={current?.name}>{current?.name || "프로젝트 선택"}</span>
      </span>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    <div ref={popover} id={id} popover="auto" className="project-popover"
      role={creating ? "dialog" : "menu"} aria-label={creating ? "새 프로젝트" : "프로젝트 전환"}
      aria-busy={busy}
      onToggle={event => setOpen(event.newState === "open")}
      onBlur={event => {
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next) && next !== trigger.current) popover.current?.hidePopover();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
        if (creating || event.metaKey || event.ctrlKey || event.altKey) return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? (index + 1) % items.length
          : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
          : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
        if (next !== null && items.length) {
          event.preventDefault();
          items[next]?.focus();
        }
      }}>
      {creating ? <form className="project-create" onSubmit={event => {
        event.preventDefault();
        if (name.trim()) void run(() => onCreate(name.trim(), question.trim()), true);
      }}>
        <div className="project-create-heading">
          <button type="button" className="icon-button" aria-label="프로젝트 목록으로" disabled={busy}
            onClick={() => { setCreating(false); setError(""); }}><ArrowLeft size={16} /></button>
          <h3>새 프로젝트</h3>
        </div>
        <label className="field">
          프로젝트 이름
          <input ref={nameInput} value={name} onChange={event => setName(event.target.value)}
            placeholder="예: 수면과 기억" required maxLength={160} disabled={busy} />
        </label>
        <details className="project-question">
          <summary>연구 질문 추가 <span>선택</span></summary>
          <label className="field">
            <textarea value={question} onChange={event => setQuestion(event.target.value)}
              aria-label="연구 질문" placeholder="이 프로젝트에서 알아보고 싶은 질문" rows={3} maxLength={20000} disabled={busy} />
          </label>
        </details>
        {error && <p className="project-error" role="alert">{error}</p>}
        <footer className="project-create-actions">
          <button type="button" disabled={busy} onClick={() => {
            setName(""); setQuestion(""); setError(""); setCreating(false);
          }}>취소</button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>{busy ? "만드는 중…" : "만들기"}</button>
        </footer>
      </form> : <>
        <div className="project-options" role="group" aria-label="프로젝트 목록">
          {projects.map(project => <button key={project.id} type="button" role="menuitemradio"
            aria-checked={project.id === projectId} tabIndex={-1} disabled={busy}
            className="project-option" onClick={() => {
              if (project.id === projectId) close();
              else void run(() => onSelect(project.id));
            }}>
            <span>{project.name}</span>
            {project.id === projectId && <Check size={16} aria-hidden="true" />}
          </button>)}
        </div>
        <div className="project-menu-footer" role="group" aria-label="프로젝트 작업">
          <button type="button" role="menuitem" tabIndex={-1} className="project-new" disabled={busy}
            onClick={() => { setError(""); setCreating(true); }}><Plus size={16} aria-hidden="true" />새 프로젝트 만들기</button>
        </div>
        {error && <p className="project-error" role="alert">{error}</p>}
      </>}
    </div>
  </div>;
}
