import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "researchbunny.inspectorWidth";
const DEFAULT_WIDTH = 340;

export function ResizableInspector({ children }: { children: ReactNode }) {
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(saved) && saved >= 280 && saved <= 800 ? saved : DEFAULT_WIDTH;
    } catch { return DEFAULT_WIDTH; }
  });
  const [available, setAvailable] = useState(1000);
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const panelId = useId();
  const max = Math.min(800, Math.max(180, available - 360));
  const min = Math.min(280, max);
  const clamp = (value: number) => Math.round(Math.max(min, Math.min(max, value)));
  const width = clamp(preferredWidth);

  useEffect(() => {
    const workspace = panel.current?.parentElement;
    if (!workspace) return;
    const measure = () => setAvailable(workspace.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, String(preferredWidth)); } catch { /* Optional preference. */ }
    }, 150);
    return () => clearTimeout(timer);
  }, [preferredWidth]);

  return <div ref={panel} id={panelId} className="resizable-inspector" style={{ width }}>
    <div className="inspector-divider" role="separator" tabIndex={0}
      aria-label="상세 패널 너비" aria-orientation="vertical" aria-controls={panelId}
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
      aria-valuetext={`${width}px`}
      title="드래그하여 너비 조절 · 더블 클릭으로 기본 너비"
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        drag.current = { x: e.clientX, width };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        if (drag.current) setPreferredWidth(clamp(drag.current.width + drag.current.x - e.clientX));
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
        const next = e.key === "ArrowLeft" ? width + step
          : e.key === "ArrowRight" ? width - step
          : e.key === "Home" ? min : e.key === "End" ? max : null;
        if (next !== null) { e.preventDefault(); setPreferredWidth(clamp(next)); }
      }}
    />
    {children}
  </div>;
}
