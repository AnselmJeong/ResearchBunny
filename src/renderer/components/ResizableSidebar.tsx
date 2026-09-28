import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "researchbunny.sidebarWidth";
const DEFAULT_WIDTH = 260;

export function ResizableSidebar({ children }: { children: ReactNode }) {
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(saved) && saved >= 200 && saved <= 480 ? saved : DEFAULT_WIDTH;
    } catch { return DEFAULT_WIDTH; }
  });
  const [available, setAvailable] = useState(window.innerWidth);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const panelId = useId();
  const max = Math.min(480, Math.max(160, available - 640));
  const min = Math.min(200, max);
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(max, value)));
  const width = clamp(preferredWidth);

  useEffect(() => {
    const shell = panel.current?.parentElement;
    if (!shell) return;
    const measure = () => setAvailable(shell.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, String(preferredWidth)); } catch { /* Optional preference. */ }
    }, 150);
    return () => clearTimeout(timer);
  }, [preferredWidth]);

  return <aside ref={panel} id={panelId} className="sidebar resizable-sidebar" style={{ width }}>
    {children}
    <div className="sidebar-divider" role="separator" tabIndex={0}
      aria-label="왼쪽 패널 너비" aria-orientation="vertical" aria-controls={panelId}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width}px`}
      title="드래그하여 너비 조절 · 더블 클릭으로 기본 너비"
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        drag.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (drag.current) setPreferredWidth(clamp(drag.current.width + e.clientX - drag.current.x));
      }}
      onPointerUp={e => {
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => setPreferredWidth(DEFAULT_WIDTH)}
      onKeyDown={e => {
        const step = e.shiftKey ? 50 : 20;
        const next = e.key === "ArrowRight" ? width + step
          : e.key === "ArrowLeft" ? width - step
          : e.key === "Home" ? min : e.key === "End" ? max : null;
        if (next !== null) { e.preventDefault(); setPreferredWidth(clamp(next)); }
      }}
    />
  </aside>;
}
