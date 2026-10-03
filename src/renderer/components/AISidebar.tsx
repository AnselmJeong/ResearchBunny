import { useEffect, useRef, useState } from "react";
import { ArrowUp, BookOpen, ExternalLink, Globe, LoaderCircle, RotateCcw, Settings2, Sparkles, Square, Plus } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { chatScope, type ChatContextRef, type ChatThreadSummary, type ChatSession, type ChatMessage } from "../../shared/chat";
import type { Settings, WorkView } from "../../shared/types";

const providerNames = { ollama: "Ollama Cloud", codex: "Codex 구독", openai: "OpenAI API" };

function Reply({ message }: { message: ChatMessage }) {
  // Only backend-recorded retrieval links are actionable. Remote images and raw HTML never load.
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children }) => <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{message.content}</Markdown>;
}

type SidebarProps = { work: WorkView | null; projectId: string; context: ChatContextRef; settings: Settings; onSettings: () => void };
export function AISidebar(props: SidebarProps) {
  const [threadId, setThreadId] = useState<string>();
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!props.work) return;
    let valid = true;
    setLoadError("");
    void window.bunny.chatSession({ projectId: props.projectId, workId: props.work.id, context: props.context })
      .then(session => { if (valid) setThreadId(session.threadId); })
      .catch(error => { if (valid) setLoadError(error instanceof Error ? error.message : "대화를 불러오지 못했습니다."); });
    return () => { valid = false; };
  }, [props.projectId, props.work?.id, chatScope(props.context), reload]);
  useEffect(() => {
    if (!props.work) return;
    let valid = true;
    const refresh = () => void window.bunny.chatThreads({ projectId: props.projectId, workId: props.work!.id, context: props.context }).then(items => { if (valid) setThreads(items); }).catch(() => {});
    refresh();
    const unsubscribe = window.bunny.onEvent(event => { if (event.type === "chat" && event.session.projectId === props.projectId && event.session.workId === props.work?.id && chatScope(event.session.context) === chatScope(props.context) && !event.session.activeRequestId) refresh(); });
    return () => { valid = false; unsubscribe(); };
  }, [props.projectId, props.work?.id, chatScope(props.context), threadId]);
  if (props.work && !threadId) return <section className="ai-sidebar"><div className="ai-welcome" role="status">{loadError || "대화 불러오는 중…"}{loadError && <button onClick={() => setReload(value => value + 1)}>다시 시도</button>}</div></section>;
  return <Conversation key={threadId || "current"} {...props} threadId={threadId} threads={threads} onSelectThread={setThreadId} />;
}

function Conversation({ work, projectId, context, settings, onSettings, threadId, threads, onSelectThread }: SidebarProps & { threadId?: string; threads: ChatThreadSummary[]; onSelectThread: (id: string) => void }) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const draftKey = `researchbunny.chat-draft:${JSON.stringify([projectId, work?.id, chatScope(context), threadId || "current"])}`;
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(draftKey) ?? ""; } catch { return ""; } });
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(!!work);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pending = useRef(false);
  const selectedThread = useRef(threadId);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    try { if (draft) localStorage.setItem(draftKey, draft); else localStorage.removeItem(draftKey); } catch { /* Drafts remain in memory. */ }
  }, [draft, draftKey]);
  useEffect(() => {
    if (!work) return;
    let valid = true;
    const accept = (next: ChatSession) => {
      if (valid && next.projectId === projectId && next.workId === work.id && chatScope(next.context) === chatScope(context) && (!selectedThread.current || selectedThread.current === next.threadId)) {
        selectedThread.current = next.threadId;
        setSession(current => !current || next.revision >= current.revision ? next : current);
      }
    };
    const unsubscribe = window.bunny.onEvent(event => {
      if (event.type === "chat" && selectedThread.current) accept(event.session);
      if (event.type === "changed") void window.bunny.chatSession({ projectId, workId: work.id, context, threadId: selectedThread.current }).then(accept).catch(() => {});
      if (event.type === "service-error") {
        setSession(null);
        setError(event.message ?? "AI 연결이 중단되었습니다.");
        // Refresh persisted state; interrupted turns are marked by the backend.
        void window.bunny.chatSession({ projectId, workId: work.id, context, threadId: selectedThread.current }).then(accept).catch(() => {});
      }
    });
    void window.bunny.chatSession({ projectId, workId: work.id, context, threadId: selectedThread.current }).then(accept).catch(e => { if (valid) setError(e.message); }).finally(() => { if (valid) setLoading(false); });
    return () => { valid = false; unsubscribe(); };
  }, [projectId, work?.id, chatScope(context), threadId]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [session?.revision, error]);
  const active = Boolean(session?.activeRequestId) || sending;
  const enabled = settings.aiEnabled && (settings.aiProvider !== "ollama" || settings.ollamaConfigured) && (settings.aiProvider !== "openai" || settings.openaiConfigured);
  const send = async (text = draft) => {
    const message = text.trim();
    if (!work || !message || active || pending.current || !enabled || loading) return;
    pending.current = true;
    setSending(true); setError(""); follow.current = true;
    try {
      const next = await window.bunny.chatSend({ projectId, workId: work.id, context, threadId: session?.threadId, requestId: crypto.randomUUID(), message, searchEnabled });
      if (mounted.current) { setSession(current => !current || next.revision >= current.revision ? next : current); setDraft(""); }
      else { try { localStorage.removeItem(draftKey); } catch { /* Optional draft storage. */ } }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "전송에 실패했습니다."); }
    finally { pending.current = false; if (mounted.current) setSending(false); }
  };
  const last = session?.messages.at(-1);
  const retry = last?.role === "assistant" && ["failed", "cancelled"].includes(last.status) ? session?.messages.at(-2)?.content : undefined;
  return <section className="ai-sidebar" aria-label="논문 AI 대화">
    <div className="ai-context">
      <div className="ai-context-label"><BookOpen size={13} /><span>{work ? context.kind === "pdf-fulltext" ? "현재 문맥 · PDF 본문" : work.abstract?.trim() ? "현재 문맥 · 초록" : "현재 문맥 · 초록 없음" : "문맥 선택"}</span></div>
      <strong title={work?.title}>{work?.title ?? "목록에서 논문을 선택하세요"}</strong>
      {work && <small>{context.kind === "pdf-fulltext" ? "첨부 PDF의 추출 텍스트를 읽습니다. 초록 대화와 별도로 보관됩니다." : work.abstract?.trim() ? "선택한 논문의 초록을 바탕으로 답합니다." : "제목만 확인할 수 있습니다. 본문 내용은 추정하지 않습니다."}</small>}
    </div>
    <div className="ai-toolbar">
      <button className="text-button" onClick={onSettings} title="AI 연결 설정"><Settings2 size={13} />{providerNames[settings.aiProvider]}</button>
      <button className="icon-button" title="새 대화 · 이전 기록 보관" aria-label="새 대화" disabled={active || !session?.messages.length} onClick={() => {
        if (work) void window.bunny.chatClear({ projectId, workId: work.id, context, threadId: session?.threadId }).then(next => { if (mounted.current) onSelectThread(next.threadId); }).catch(e => { if (mounted.current) setError(e.message); });
      }}><Plus size={15} /></button>
    </div>
    {session && <label className="ai-history"><span>대화 이력</span><select aria-label="AI 대화 이력" value={session.threadId} onChange={event => onSelectThread(event.target.value)}>
      {!threads.some(t => t.threadId === session.threadId) && <option value={session.threadId}>현재 대화</option>}
      {threads.map(t => <option value={t.threadId} key={t.threadId}>{t.title} · {new Date(t.createdAt).toLocaleDateString()}</option>)}
    </select><small>모든 대화는 이 라이브러리의 DB에 저장됩니다.</small></label>}
    <div className="ai-messages" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; }}>
      {loading ? <p className="subtle"><LoaderCircle size={15} className="spin" /> 대화 불러오는 중…</p> : !session?.messages.length && <div className="ai-welcome">
        <Sparkles size={24} strokeWidth={1.3} /><h3>이 논문을 함께 읽어보세요</h3>
        <p>{work ? "핵심 결과를 정리하거나 연구의 한계를 질문하세요." : "논문을 선택하면 초록이 대화의 문맥이 됩니다."}</p>
        {work && enabled && <div className="ai-prompts">{["핵심 질문과 결과를 요약해 줘", context.kind === "pdf-fulltext" ? "본문에서 확인되는 연구의 한계는?" : "초록에서 확인되는 연구의 한계는?", "연구 방법을 쉽게 설명해 줘"].map(prompt => <button key={prompt} onClick={() => setDraft(prompt)}>{prompt}</button>)}</div>}
      </div>}
      {session?.messages.map(message => <article key={message.id} className={`ai-message ${message.role}`}>
        <div className="ai-message-label">{message.role === "user" ? "나" : providerNames[message.provider as keyof typeof providerNames] ?? "AI"}{message.role === "assistant" && message.searchEnabled && <span><Globe size={11} /> 검색 사용</span>}</div>
        {message.role === "user" ? <p>{message.content}</p> : <div className="ai-markdown"><Reply message={message} /></div>}
        {message.status === "streaming" && <p className="ai-phase" role="status"><LoaderCircle size={13} className="spin" />{session.phase}</p>}
        {message.notice && <p className="ai-notice" role="status">{message.notice}</p>}
        {!!message.sources?.length && <details className="ai-sources"><summary>검색 근거 {message.sources.length}편</summary>{message.sources.map((source, index) => <button key={`${source.url}:${index}`} onClick={() => {
          if (work) void window.bunny.chatOpenSource({ projectId, workId: work.id, context, threadId: session?.threadId, messageId: message.id, index }).catch(e => setError(e.message));
        }}><span>[{index + 1}] {source.title}<small>{source.source === "pubmed" ? "PubMed" : source.source === "openalex-semantic" ? "OpenAlex" : "TinyFish"}</small></span><ExternalLink size={12} /></button>)}</details>}
      </article>)}
      {retry && !active && <button className="text-button" onClick={() => void send(retry)} disabled={!enabled}><RotateCcw size={13} />같은 질문 다시 보내기</button>}
      {error && <p className="ai-notice" role="alert">{error}</p>}
    </div>
    {!enabled && <div className="ai-setup"><span>{settings.aiEnabled ? "AI 연결을 설정해 주세요." : "설정에서 AI 사용을 켜 주세요."}</span><button className="text-button" onClick={onSettings}>설정 열기</button></div>}
    <form className="ai-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="논문에 대해 질문" placeholder={work ? "이 논문에 대해 질문하세요…" : "먼저 논문을 선택하세요"} value={draft} disabled={!work} rows={3} maxLength={8000} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
      }} />
      <div className="ai-composer-actions">
        <button type="button" className={`ai-search-toggle ${searchEnabled ? "active" : ""}`} role="switch" aria-checked={searchEnabled} disabled={active} title="OpenAlex·PubMed 우선 검색, 부족할 때 TinyFish로 보완" onClick={() => setSearchEnabled(value => !value)}><Globe size={14} />검색 {searchEnabled ? "켜짐" : "꺼짐"}</button>
        {active ? <button type="button" className="ai-send" aria-label="답변 중지" disabled={!session?.activeRequestId} onClick={() => {
          if (work && session?.activeRequestId) void window.bunny.chatCancel({ projectId, workId: work.id, context, threadId: session.threadId, requestId: session.activeRequestId }).catch(e => setError(e.message));
        }}><Square size={14} fill="currentColor" /></button> : <button type="submit" className="ai-send" aria-label="질문 보내기" disabled={!work || !enabled || !draft.trim() || loading}><ArrowUp size={18} /></button>}
      </div>
      <small>Enter 전송 · Shift+Enter 줄바꿈</small>
    </form>
  </section>;
}
