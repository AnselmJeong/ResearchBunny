import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, Maximize, Minus, MoveHorizontal, Plus, RotateCcw } from "lucide-react";
import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import { usePdfiumEngine } from "@embedpdf/engines/react";
import { PdfErrorCode } from "@embedpdf/models";
import { DocumentContent, DocumentManagerPluginPackage } from "@embedpdf/plugin-document-manager/react";
import { InteractionManagerPluginPackage, PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { RenderLayer, RenderPluginPackage } from "@embedpdf/plugin-render/react";
import { Scroller, ScrollPluginPackage, ScrollStrategy, useScroll, useScrollCapability, type ScrollScope } from "@embedpdf/plugin-scroll/react";
import { SelectionLayer, SelectionPluginPackage, useSelectionCapability } from "@embedpdf/plugin-selection/react";
import { TilingLayer, TilingPluginPackage } from "@embedpdf/plugin-tiling/react";
import { useViewportCapability, Viewport, ViewportPluginPackage } from "@embedpdf/plugin-viewport/react";
import { useZoom, useZoomCapability, ZoomGestureWrapper, ZoomMode, ZoomPluginPackage, type ZoomLevel } from "@embedpdf/plugin-zoom/react";
import pdfiumWasm from "@embedpdf/pdfium/pdfium.wasm?url";
import type { WorkView } from "../../shared/types";

// The engine worker fetches the wasm itself, so it needs an absolute views:// URL.
const WASM_URL = new URL(pdfiumWasm, document.baseURI).href;
const ZOOM_KEY = "researchbunny.reader.zoom";
// Pages sit further apart than the viewport gap, so a fitted page shows no sliver of its neighbours.
const VIEWPORT_GAP = 16;
const PAGE_GAP = 20;
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function savedZoom(): ZoomLevel {
  try {
    const value = JSON.parse(localStorage.getItem(ZOOM_KEY) || "null");
    if (value === ZoomMode.FitPage || value === ZoomMode.FitWidth) return value;
    if (typeof value === "number" && value >= .25 && value <= 5) return value;
  } catch { /* Optional preference. */ }
  return ZoomMode.FitWidth;
}

type Controls = { page: number; pages: number; go: (page: number) => void; zoom: number; level: ZoomLevel; setZoom: (level: ZoomLevel) => void; zoomIn: () => void; zoomOut: () => void };

function ReaderToolbar({ controls: c, onExternal }: { controls?: Controls; onExternal: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { if (c && draft) c.go(Number(draft)); setDraft(null); };
  return <div className="reader-toolbar" aria-label="PDF 도구">
    <button aria-label="이전 페이지" title="이전 페이지 (←)" disabled={!c || c.page <= 1} onClick={() => c?.go(c.page - 1)}><ChevronLeft size={17} /></button>
    <label><input aria-label="PDF 페이지" type="number" min={1} max={c?.pages || 1} value={draft ?? c?.page ?? 1} disabled={!c} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setDraft(null); }} /><span>/ {c?.pages || "—"}</span></label>
    <button aria-label="다음 페이지" title="다음 페이지 (→)" disabled={!c || c.page >= c.pages} onClick={() => c?.go(c.page + 1)}><ChevronRight size={17} /></button>
    <span className="reader-divider" />
    <button aria-label="축소" title="축소 (⌘−)" disabled={!c} onClick={() => c?.zoomOut()}><Minus size={15} /></button>
    <button className="reader-zoom" title="실제 크기 (⌘0)" disabled={!c} onClick={() => c?.setZoom(1)}>{c ? `${Math.round(c.zoom * 100)}%` : "—"}</button>
    <button aria-label="확대" title="확대 (⌘+)" disabled={!c} onClick={() => c?.zoomIn()}><Plus size={15} /></button>
    <span className="reader-divider" />
    <button className={c?.level === ZoomMode.FitWidth ? "active" : ""} aria-pressed={c?.level === ZoomMode.FitWidth} title="페이지 폭을 창에 맞추고 이어서 스크롤" disabled={!c} onClick={() => c?.setZoom(ZoomMode.FitWidth)}><MoveHorizontal size={14} />폭 맞춤</button>
    <button className={c?.level === ZoomMode.FitPage ? "active" : ""} aria-pressed={c?.level === ZoomMode.FitPage} title="한 쪽 전체를 창에 맞춤 (↑↓←→로 쪽 넘김)" disabled={!c} onClick={() => c?.setZoom(ZoomMode.FitPage)}><Maximize size={14} />페이지 맞춤</button>
    <button className="reader-external" title="외부 앱에서 열기" onClick={onExternal}><ExternalLink size={14} /></button>
  </div>;
}

function ReaderStatus({ error, children, onRetry }: { error?: string; children?: React.ReactNode; onRetry?: () => void }) {
  return error
    ? <div className="reader-error" role="alert"><p>{error}</p>{onRetry && <button onClick={onRetry}><RotateCcw size={14} />다시 열기</button>}</div>
    : <div className="reader-loading" role="status"><LoaderCircle className="spin" size={24} /><span>{children}</span></div>;
}

// Leave the viewport gap above the page (a fitted page ends up centred) and keep the horizontal position.
function showPage(scope: ScrollScope, viewport: HTMLElement | null | undefined, page: number) {
  const left = viewport?.scrollLeft ?? 0;
  const pageNumber = Math.max(1, Math.min(scope.getTotalPages(), Math.trunc(page) || 1));
  scope.scrollToPage({ pageNumber, pageCoordinates: { x: 0, y: 0 }, alignY: viewport?.clientHeight ? VIEWPORT_GAP / viewport.clientHeight * 100 : 0, behavior: "instant" });
  // The viewport applies scroll requests on the next frame, so restore the column after it.
  if (viewport) requestAnimationFrame(() => { viewport.scrollLeft = left; });
}

function copyText(text: string) {
  let copied = false;
  const write = (e: ClipboardEvent) => { e.clipboardData?.setData("text/plain", text); e.preventDefault(); copied = true; };
  document.addEventListener("copy", write);
  try { document.execCommand("copy"); } finally { document.removeEventListener("copy", write); }
  if (!copied) void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** A page someone asked for (a passage search hit); `at` tells two requests for the same page apart. */
type Jump = { page: number; at: number };

function ReaderSurface({ documentId, initialPage, jump, preferenceKey, visible, onExternal }: { documentId: string; initialPage: number; jump?: Jump; preferenceKey: string; visible: boolean; onExternal: () => void }) {
  const { state: { currentPage, totalPages } } = useScroll(documentId);
  const { state: zoomState } = useZoom(documentId);
  const { provides: scrollCapability } = useScrollCapability();
  const { provides: zoomCapability } = useZoomCapability();
  const { provides: viewportCapability } = useViewportCapability();
  const { provides: selection } = useSelectionCapability();
  // forDocument() builds a new scope on every call; keep one per document so effects stay put.
  const scroll = useMemo(() => scrollCapability?.forDocument(documentId), [scrollCapability, documentId]);
  const zoom = useMemo(() => zoomCapability?.forDocument(documentId), [zoomCapability, documentId]);
  const surface = useRef<HTMLDivElement>(null);
  const restored = useRef(initialPage <= 1);
  const lastPage = useRef(initialPage);
  const selectedText = useRef("");
  const fitPage = zoomState.zoomLevel === ZoomMode.FitPage;
  const viewport = () => surface.current?.querySelector<HTMLElement>(".reader-viewport");
  const go = (page: number) => { if (scroll) showPage(scroll, viewport(), page); };
  /** Whether a page's top is at the top of the visible viewport; a hidden reader is at no page. */
  const atPage = (page: number) => {
    const el = viewport();
    const target = el?.querySelector<HTMLElement>(`.reader-page[data-page="${page}"]`);
    if (!el?.clientHeight || !target) return false;
    const offset = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    return offset > -40 && offset < 80;
  };
  /**
   * Scroll requests made while the first layout settles (zoom fitting) or while
   * the reader is still hidden are dropped, though the scroll state already
   * reports the page; repeat until that page is really in view.
   */
  const settle = (page: number, tries = 40) => {
    if (!scroll || atPage(page)) return;
    go(page);
    setTimeout(() => {
      if (tries > 0 && !atPage(page)) settle(page, tries - 1);
    }, 50);
  };
  const setZoom = (level: ZoomLevel) => {
    if (!zoom || !scroll) return;
    const page = scroll.getCurrentPage();
    const el = viewport();
    // Keep the line at the top of the view in place rather than the middle of the screen.
    zoom.requestZoom(level, el ? { vx: el.clientWidth / 2, vy: 0 } : undefined);
    // A fitted page is only useful when the whole page is in view.
    if (level === ZoomMode.FitPage) requestAnimationFrame(() => go(page));
  };
  const controls: Controls | undefined = scroll && zoom ? { page: currentPage, pages: totalPages, go, zoom: zoomState.currentZoomLevel, level: zoomState.zoomLevel, setZoom, zoomIn: () => zoom.zoomIn(), zoomOut: () => zoom.zoomOut() } : undefined;

  useEffect(() => {
    if (!viewportCapability || !zoom) return;
    // The SDK only re-applies fit modes once the viewport is measured; a saved percentage would keep pages hidden.
    const release = () => {
      const level = zoom.getState().zoomLevel;
      if (typeof level === "number" && viewportCapability.forDocument(documentId).hasGate("zoom")) zoom.requestZoom(level);
    };
    release();
    return viewportCapability.onViewportResize(event => { if (event.documentId === documentId) release(); });
  }, [viewportCapability, zoom, documentId]);
  useEffect(() => {
    if (!scrollCapability || !scroll || restored.current) return;
    let frame = 0;
    const restore = () => {
      if (restored.current) return;
      restored.current = true;
      cancelAnimationFrame(frame);
      requestAnimationFrame(() => settle(lastPage.current));
    };
    const off = scrollCapability.onLayoutReady(event => { if (event.documentId === documentId) restore(); });
    // A small PDF can be laid out before this effect subscribes, and that event is not sent again.
    const poll = (tries: number) => {
      if (restored.current) return;
      const el = viewport();
      if (scroll.getTotalPages() >= lastPage.current && el && el.scrollHeight > el.clientHeight) restore();
      else if (tries > 0) frame = requestAnimationFrame(() => poll(tries - 1));
    };
    poll(120);
    return () => { off(); cancelAnimationFrame(frame); };
  }, [scrollCapability, scroll, documentId]);
  useEffect(() => {
    // Before the first layout the restore above opens this page; afterwards a jump moves the open document.
    if (!jump || !scroll) return;
    lastPage.current = jump.page;
    if (restored.current) requestAnimationFrame(() => settle(jump.page));
  }, [jump?.at]);
  useEffect(() => {
    // A hidden reader reports an empty viewport; keep the page it was left on.
    if (!visible || !restored.current) return;
    lastPage.current = currentPage;
    try { localStorage.setItem(preferenceKey, JSON.stringify({ page: currentPage })); } catch { /* Optional reading position. */ }
  }, [preferenceKey, currentPage, visible]);
  useEffect(() => {
    if (!visible || !scroll) return;
    const frame = requestAnimationFrame(() => {
      if (restored.current && scroll.getCurrentPage() !== lastPage.current) go(lastPage.current);
      viewport()?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, scroll]);
  useEffect(() => { try { localStorage.setItem(ZOOM_KEY, JSON.stringify(zoomState.zoomLevel)); } catch { /* Optional preference. */ } }, [zoomState.zoomLevel]);
  useEffect(() => {
    if (!selection) return;
    const scope = selection.forDocument(documentId);
    let revision = 0;
    const reset = () => { revision++; selectedText.current = ""; };
    const stops = [
      scope.onBeginSelection(reset),
      scope.onSelectionChange(range => { if (!range) reset(); }),
      scope.onEndSelection(() => {
        const mine = ++revision;
        scope.getSelectedText().wait(lines => { if (mine === revision) selectedText.current = lines.join("\n").replace(/\r\n?/g, "\n").trim(); }, () => undefined);
      }),
    ];
    return () => stops.forEach(stop => stop());
  }, [selection, documentId]);
  useEffect(() => {
    if (!visible || !scroll || !zoom) return;
    const keydown = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (e.defaultPrevented || e.isComposing || target?.closest(EDITABLE)) return;
      // Keys typed into the sidebars or a dialog stay there.
      if (target && target !== document.body && !surface.current?.closest(".article-reader")?.contains(target)) return;
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        const action = e.altKey ? undefined : key === "=" || key === "+" ? () => zoom.zoomIn() : key === "-" ? () => zoom.zoomOut() : key === "0" ? () => setZoom(1) : key === "c" && !e.shiftKey && selectedText.current ? () => copyText(selectedText.current) : undefined;
        if (action) { e.preventDefault(); action(); }
        return;
      }
      if (e.altKey || e.shiftKey) return;
      const page = scroll.getCurrentPage();
      const step = ({ ArrowLeft: -1, PageUp: -1, ArrowRight: 1, PageDown: 1, ...(fitPage ? { ArrowUp: -1, ArrowDown: 1 } : {}) } as Record<string, number>)[e.key];
      const next = step ? page + step : e.key === "Home" ? 1 : e.key === "End" ? scroll.getTotalPages() : 0;
      if (!next) return;
      e.preventDefault();
      go(next);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const renderPage = ({ pageIndex, width, height }: { pageIndex: number; width: number; height: number }) => <div className="reader-page" data-page={pageIndex + 1} style={{ width, height }}>
    <PagePointerProvider documentId={documentId} pageIndex={pageIndex}>
      <RenderLayer documentId={documentId} pageIndex={pageIndex} scale={1} className="reader-page-layer" draggable={false} />
      <TilingLayer documentId={documentId} pageIndex={pageIndex} className="reader-page-layer" />
      <SelectionLayer documentId={documentId} pageIndex={pageIndex} textStyle={{ background: "rgba(144, 185, 151, 0.55)" }} />
    </PagePointerProvider>
  </div>;
  return <>
    <ReaderToolbar controls={controls} onExternal={onExternal} />
    <div className="reader-surface" ref={surface}>
      <Viewport documentId={documentId} className="reader-viewport" tabIndex={0} aria-label="PDF 페이지 내용" onPointerDown={e => e.currentTarget.focus({ preventScroll: true })}>
        <ZoomGestureWrapper documentId={documentId}>
          <Scroller documentId={documentId} renderPage={renderPage} />
        </ZoomGestureWrapper>
      </Viewport>
    </div>
  </>;
}

function PdfView({ file, initialPage, jump, preferenceKey, visible, onExternal, onRetry }: { file: { name: string; buffer: ArrayBuffer }; initialPage: number; jump?: Jump; preferenceKey: string; visible: boolean; onExternal: () => void; onRetry: () => void }) {
  const { engine, isLoading, error } = usePdfiumEngine({ wasmUrl: WASM_URL, worker: true, fontFallback: null });
  const plugins = useMemo(() => [
    createPluginRegistration(DocumentManagerPluginPackage, { maxDocuments: 1, initialDocuments: [{ buffer: file.buffer, name: file.name, autoActivate: true }] }),
    createPluginRegistration(ViewportPluginPackage, { viewportGap: VIEWPORT_GAP }),
    createPluginRegistration(ScrollPluginPackage, { defaultStrategy: ScrollStrategy.Vertical, defaultPageGap: PAGE_GAP, defaultBufferSize: 2 }),
    createPluginRegistration(RenderPluginPackage),
    createPluginRegistration(TilingPluginPackage, { tileSize: 768, overlapPx: 2, extraRings: 1 }),
    createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: savedZoom(), minZoom: .25, maxZoom: 5, zoomStep: .1 }),
    createPluginRegistration(InteractionManagerPluginPackage),
    createPluginRegistration(SelectionPluginPackage, { marquee: { enabled: false } }),
  ], [file]);
  const loading = (message: string) => <><ReaderToolbar onExternal={onExternal} /><ReaderStatus>{message}</ReaderStatus></>;
  if (error) return <ReaderStatus error={`PDF 엔진을 시작하지 못했습니다: ${error.message}`} onRetry={onRetry} />;
  if (isLoading || !engine) return loading("PDF 엔진 준비 중…");
  return <EmbedPDF engine={engine} plugins={plugins}>
    {({ activeDocumentId }) => !activeDocumentId ? loading("PDF 여는 중…") : <DocumentContent documentId={activeDocumentId}>
      {({ documentState, isLoaded, isError }) => isError
        ? <ReaderStatus error={documentState.errorCode === PdfErrorCode.Password ? "암호가 있는 PDF입니다. 암호를 해제한 사본을 첨부하거나 외부 앱에서 열어 주세요." : `PDF를 열지 못했습니다: ${documentState.error || "알 수 없는 오류"}`} onRetry={onRetry} />
        : isLoaded ? <ReaderSurface documentId={activeDocumentId} initialPage={initialPage} jump={jump} preferenceKey={preferenceKey} visible={visible} onExternal={onExternal} /> : loading("PDF 여는 중…")}
    </DocumentContent>}
  </EmbedPDF>;
}

export function ArticleReader({ projectId, work, attachmentId, jump, visible, onBrowse }: { projectId: string; work: WorkView; attachmentId: string; jump?: Jump; visible: boolean; onBrowse: () => void }) {
  const [file, setFile] = useState<{ name: string; buffer: ArrayBuffer } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [retry, setRetry] = useState(0);
  const preferenceKey = `researchbunny.reader:${JSON.stringify([projectId, work.id, attachmentId])}`;
  // Opening at a passage's page wins over the page the reader was left on; later jumps move the open document.
  const firstJump = useRef(jump);
  const initialPage = useMemo(() => {
    if (firstJump.current) return firstJump.current.page;
    try { return Math.max(1, Number(JSON.parse(localStorage.getItem(preferenceKey) || "{}").page) || 1); } catch { return 1; }
  }, [preferenceKey, retry]);
  useEffect(() => {
    let cancelled = false;
    setError(""); setFile(null); setProgress(0);
    void (async () => {
      const target = { projectId, workId: work.id, attachmentId };
      const info = await window.bunny.pdfInfo(target);
      if (cancelled) return;
      setName(info.name);
      const data = new Uint8Array(info.size);
      for (let offset = 0; offset < info.size;) {
        const chunk = await window.bunny.pdfReadChunk({ ...target, offset, length: 512 * 1024 });
        if (cancelled) return;
        if (!chunk.bytesRead) throw new Error("PDF 파일을 끝까지 읽지 못했습니다.");
        const bytes = Uint8Array.from(atob(chunk.base64), c => c.charCodeAt(0));
        data.set(bytes, offset); offset += chunk.bytesRead;
        setProgress(Math.round(offset / info.size * 100));
      }
      setFile({ name: info.name, buffer: data.buffer });
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "PDF를 열지 못했습니다."); });
    return () => { cancelled = true; };
  }, [projectId, work.id, attachmentId, retry]);
  const onExternal = () => void window.bunny.attachmentAction({ attachmentId, action: "open" }).catch(e => setError(e.message));
  const onRetry = () => setRetry(v => v + 1);
  return <main className="article-reader" hidden={!visible} aria-label="논문 원문 보기">
    <header className="reader-heading"><div><span className="eyebrow">FULL TEXT</span><h2 title={work.title}>{work.title}</h2><small title={name}>{name || "첨부 PDF"}</small></div><button className="text-button" onClick={onBrowse}>목록으로 돌아가기</button></header>
    {error ? <><ReaderToolbar onExternal={onExternal} /><ReaderStatus error={error} onRetry={onRetry} /></>
      : !file ? <><ReaderToolbar onExternal={onExternal} /><ReaderStatus>PDF 불러오는 중… {progress}%</ReaderStatus></>
      : <PdfView key={retry} file={file} initialPage={initialPage} jump={jump} preferenceKey={preferenceKey} visible={visible} onExternal={onExternal} onRetry={onRetry} />}
  </main>;
}
