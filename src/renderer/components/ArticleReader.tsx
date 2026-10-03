import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, Minus, Plus, RotateCcw } from "lucide-react";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { WorkView } from "../../shared/types";

GlobalWorkerOptions.workerSrc = workerUrl;

export function ArticleReader({ projectId, work, attachmentId, visible, onBrowse }: { projectId: string; work: WorkView; attachmentId: string; visible: boolean; onBrowse: () => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [retry, setRetry] = useState(0);
  const preferenceKey = `researchbunny.reader:${JSON.stringify([projectId, work.id, attachmentId])}`;
  const [page, setPage] = useState(() => { try { return Math.max(1, Number(JSON.parse(localStorage.getItem(preferenceKey) || "{}").page) || 1); } catch { return 1; } });
  const [zoom, setZoom] = useState<number | "fit">(() => { try { const z = JSON.parse(localStorage.getItem(preferenceKey) || "{}").zoom; return typeof z === "number" && z >= .25 && z <= 3 ? z : "fit"; } catch { return "fit"; } });
  const [width, setWidth] = useState(600);
  const [rendering, setRendering] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(preferenceKey, JSON.stringify({ page, zoom })); } catch { /* Optional reading position. */ } }, [preferenceKey, page, zoom]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(entries => { const w = entries[0]?.contentRect.width; if (w && w > 100) setWidth(w); });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | undefined;
    setError(""); setPdf(null); setProgress(0);
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
      const base = new URL("pdfjs/", document.baseURI).href;
      task = getDocument({ data, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/` });
      task.onPassword = () => { if (!cancelled) setError("암호가 있는 PDF입니다. 암호를 해제한 사본을 첨부하거나 외부 앱에서 열어 주세요."); void task?.destroy(); };
      const loaded = await task.promise;
      if (cancelled) return;
      setPage(value => Math.min(value, loaded.numPages)); setPdf(loaded);
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "PDF를 열지 못했습니다."); });
    return () => { cancelled = true; void task?.destroy(); };
  }, [projectId, work.id, attachmentId, retry]);
  useEffect(() => {
    if (!pdf || !surface.current || !visible) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    let text: TextLayer | undefined;
    const host = surface.current;
    const canvas = document.createElement("canvas");
    const layer = document.createElement("div"); layer.className = "textLayer";
    host.replaceChildren(canvas, layer);
    setRendering(true);
    void (async () => {
      const p = await pdf.getPage(page);
      if (cancelled) return;
      const scale = zoom === "fit" ? Math.max(.1, (width - 48) / p.getViewport({ scale: 1 }).width) : zoom;
      const v = p.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, 8192 / Math.max(v.width, v.height));
      canvas.width = Math.floor(v.width * ratio); canvas.height = Math.floor(v.height * ratio);
      canvas.style.width = `${v.width}px`; canvas.style.height = `${v.height}px`;
      host.style.width = `${v.width}px`; host.style.height = `${v.height}px`;
      host.style.setProperty("--total-scale-factor", String(scale));
      host.style.setProperty("--scale-factor", String(scale));
      render = p.render({ canvas, viewport: v, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (cancelled) return;
      text = new TextLayer({ textContentSource: p.streamTextContent(), container: layer, viewport: v });
      await text.render();
    })().catch(e => { if (!cancelled) setError(`PDF 페이지를 표시하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); }).finally(() => { if (!cancelled) setRendering(false); });
    return () => { cancelled = true; render?.cancel(); text?.cancel(); };
  }, [pdf, page, zoom, width, visible]);
  const move = (next: number) => { if (pdf) { setPage(Math.max(1, Math.min(pdf.numPages, next))); viewport.current?.scrollTo(0, 0); } };
  return <main className="article-reader" hidden={!visible} aria-label="논문 원문 보기">
    <header className="reader-heading"><div><span className="eyebrow">FULL TEXT</span><h2 title={work.title}>{work.title}</h2><small title={name}>{name || "첨부 PDF"}</small></div><button className="text-button" onClick={onBrowse}>목록으로 돌아가기</button></header>
    <div className="reader-toolbar" aria-label="PDF 도구">
      <button aria-label="이전 페이지" disabled={!pdf || page <= 1} onClick={() => move(page - 1)}><ChevronLeft size={17} /></button>
      <label><input aria-label="PDF 페이지" type="number" min={1} max={pdf?.numPages || 1} value={page} disabled={!pdf} onChange={e => { if (e.target.value) move(Number(e.target.value)); }} /><span>/ {pdf?.numPages || "—"}</span></label>
      <button aria-label="다음 페이지" disabled={!pdf || page >= pdf.numPages} onClick={() => move(page + 1)}><ChevronRight size={17} /></button>
      <span className="reader-divider" />
      <button aria-label="축소" disabled={!pdf} onClick={() => setZoom(z => Math.max(.25, (z === "fit" ? 1 : z) - .25))}><Minus size={15} /></button>
      <button className={zoom === "fit" ? "active" : ""} disabled={!pdf} onClick={() => setZoom("fit")} title="폭에 맞추기">{zoom === "fit" ? "폭 맞춤" : `${Math.round(zoom * 100)}%`}</button>
      <button aria-label="확대" disabled={!pdf} onClick={() => setZoom(z => Math.min(3, (z === "fit" ? 1 : z) + .25))}><Plus size={15} /></button>
      <button className="reader-external" title="외부 앱에서 열기" onClick={() => void window.bunny.attachmentAction({ attachmentId, action: "open" }).catch(e => setError(e.message))}><ExternalLink size={14} /></button>
    </div>
    {error ? <div className="reader-error" role="alert"><p>{error}</p><button onClick={() => setRetry(v => v + 1)}><RotateCcw size={14} />다시 열기</button></div> : !pdf ? <div className="reader-loading" role="status"><LoaderCircle className="spin" size={24} /><span>PDF 불러오는 중… {progress}%</span></div> : null}
    <div className="reader-viewport" ref={viewport} tabIndex={0} aria-label="PDF 페이지 내용" onKeyDown={e => {
      if (e.target !== e.currentTarget || !pdf || e.metaKey || e.ctrlKey || e.altKey) return;
      if (["ArrowRight", "PageDown", "ArrowLeft", "PageUp", "Home", "End"].includes(e.key)) { e.preventDefault(); move(e.key === "Home" ? 1 : e.key === "End" ? pdf.numPages : page + (["ArrowRight", "PageDown"].includes(e.key) ? 1 : -1)); }
    }}><div className="reader-page" ref={surface} hidden={!pdf || !!error} />{rendering && pdf && !error && <span className="reader-rendering" role="status">페이지 표시 중…</span>}</div>
  </main>;
}
