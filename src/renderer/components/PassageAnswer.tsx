import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpenText, Check, LoaderCircle, RefreshCw, Square, TriangleAlert } from "lucide-react";
import type { AnswerRef, AnswerStatement, AnswerStep, PassageAnswer, PassageHit } from "../../shared/passages";

const STEPS: [AnswerStep, string][] = [["plan", "질문 나누기"], ["search", "본문 구절 찾기"], ["write", "답변 쓰기"], ["check", "인용 확인"]];
const PROVIDERS: Record<string, string> = { codex: "Codex", claude: "Claude", ollama: "Ollama", openai: "OpenAI API" };
const pages = (hit: PassageHit) => (hit.pageEnd > hit.page ? `p. ${hit.page}–${hit.pageEnd}` : `p. ${hit.page}`);
const byline = (hit: PassageHit) => `${hit.authors.slice(0, 2).join(" · ") || "저자 미상"}${hit.authors.length > 2 ? " 외" : ""} · ${hit.year || "연도 미상"}`;

/** A quote as a pattern over the passage: any spacing, either kind of quotation mark or dash, any case. */
function quotePattern(quote: string) {
  const words = quote.trim().replace(/^["'“”‘’]+|["'“”‘’.,;:]+$/g, "").split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/["“”]/g, "[\"“”]").replace(/['‘’]/g, "['‘’]").replace(/[-–—]/g, "[-–—]");
  return words.map(escape).join("[\\s\\u00ad]+");
}
/** The passage with its checked quotes marked; text is split, never parsed as HTML. */
function marked(text: string, quotes: string[]): ReactNode {
  const parts = quotes.flatMap((q) => q.split(/\s*(?:\.\.\.|…)\s*/)).map(quotePattern).filter((p): p is string => !!p);
  if (!parts.length) return text;
  const pattern = new RegExp(`(${parts.join("|")})`, "giu");
  return text.split(pattern).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

function Evidence({ hit, n, quotes, focused, onOpen, onInspect }: { hit: PassageHit; n?: number; quotes: string[]; focused: boolean; onOpen: () => void; onInspect: () => void }) {
  const [open, setOpen] = useState(false);
  const long = hit.text.length > 520;
  return <li id={n ? `answer-ref-${n}` : undefined} className={`answer-ref${focused ? " focused" : ""}`}>
    {n && <span className="answer-ref-n" aria-hidden="true">{n}</span>}
    <div className="answer-ref-body">
      <button className="passage-title" onClick={onInspect} title="논문 정보 보기">
        <strong>{hit.title}</strong>
        <span>{byline(hit)}</span>
      </button>
      <div className="passage-meta">
        <button className="passage-page" title="원문에서 이 쪽 열기" aria-label={`원문 ${pages(hit)} 열기`} onClick={onOpen}><BookOpenText size={12} aria-hidden="true" />{pages(hit)}</button>
        {hit.section && <span className="passage-section" title={hit.section}>{hit.section}</span>}
      </div>
      <p className={`passage-text${long && !open ? " clamped" : ""}`}>{marked(hit.text.replace(/\n\n/g, "\n"), quotes)}</p>
      {long && <button className="text-button passage-more" onClick={() => setOpen(!open)}>{open ? "접기" : "구절 전체 보기"}</button>}
    </div>
  </li>;
}

function Statement({ statement, onCite }: { statement: AnswerStatement; onCite: (n: number) => void }) {
  const note = statement.status === "unverified" ? "인용문을 그 구절에서 찾지 못해 근거를 확인하지 못한 문장입니다."
    : statement.status === "uncited" ? "인용이 없는 문장입니다." : statement.unsupported.length ? `인용한 구절에 없는 수치: ${statement.unsupported.join(", ")}` : "";
  return <span className={`answer-statement ${statement.status}${statement.unsupported.length ? " unsupported" : ""}`} title={note || undefined}>
    {statement.text}
    {statement.refs.map((n) => <button key={n} className="answer-cite" aria-label={`근거 ${n} 보기`} onClick={() => onCite(n)}>{n}</button>)}
    {(statement.status === "unverified" || statement.unsupported.length > 0) && <TriangleAlert size={12} className="answer-warn" aria-label={note} />}
    {" "}
  </span>;
}

/**
 * An answer to the shelf search's question, written by the connected AI from
 * the shelf's passages only. Citations are numbered passages whose quotes the
 * service found in the passage text; the passages are listed below the answer.
 */
export function PassageAnswerView({ projectId, question, folderId, onOpen, onInspect, onSettings }: {
  projectId: string;
  question: string;
  folderId?: string;
  onOpen: (workId: string, attachmentId: string | undefined, page: number) => void;
  onInspect: (workId: string) => void;
  onSettings: () => void;
}) {
  const [answer, setAnswer] = useState<PassageAnswer | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [step, setStep] = useState<{ step: AnswerStep; message: string } | null>(null);
  const [running, setRunning] = useState(false);
  // 다시 답하기 bumps `attempt` and asks the service to skip its kept answer, for that request only.
  const [attempt, setAttempt] = useState(0);
  const force = useRef(false);
  const [focused, setFocused] = useState<number | null>(null);
  const askRef = useRef<string | null>(null);
  const again = () => {
    force.current = true;
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    const askId = crypto.randomUUID();
    const fresh = force.current;
    force.current = false;
    askRef.current = askId;
    let done = false;
    setAnswer(null);
    setError(null);
    setStep(null);
    setRunning(true);
    const off = window.bunny.onEvent((event) => {
      if (event.type === "answer" && event.id === askId) setStep({ step: event.step, message: event.message });
    });
    window.bunny.passageAsk({ projectId, question, folderId, askId, fresh })
      .then((next) => { if (askRef.current === askId) setAnswer(next); })
      .catch((reason: { code?: string; message?: string }) => {
        if (askRef.current === askId && reason?.code !== "CANCELLED") setError({ code: reason?.code, message: reason?.message || "답변을 만들지 못했습니다." });
      })
      .finally(() => {
        done = true;
        if (askRef.current === askId) setRunning(false);
      });
    // Leaving the view or changing the question stops the request instead of spending the AI on it.
    return () => {
      off();
      askRef.current = null;
      if (!done) void window.bunny.passageAskCancel({ askId }).catch(() => {});
    };
  }, [projectId, question, folderId, attempt]);

  const cite = (n: number) => {
    // Cleared first so the same citation flashes again on a second click.
    setFocused(null);
    setTimeout(() => setFocused(n), 30);
    document.getElementById(`answer-ref-${n}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const open = (hit: PassageHit) => onOpen(hit.workId, hit.attachmentId ?? undefined, hit.page);
  const paragraphs = (answer?.statements || []).reduce<AnswerStatement[][]>((all, s, i) => {
    if (i === 0 || s.paragraph) all.push([s]);
    else all[all.length - 1].push(s);
    return all;
  }, []);
  const reached = STEPS.findIndex(([key]) => key === step?.step);

  return <div className="answer-view" aria-busy={running}>
    {running && <div className="answer-progress" role="status">
      <ol>
        {STEPS.map(([key, label], i) => <li key={key} className={i < reached ? "done" : i === reached ? "current" : ""}>
          {i < reached ? <Check size={12} aria-hidden="true" /> : i === reached ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}
          {label}
        </li>)}
      </ol>
      <span className="subtle">{step?.message || "준비 중"}</span>
      <button className="text-button" onClick={() => askRef.current && void window.bunny.passageAskCancel({ askId: askRef.current })}><Square size={11} />취소</button>
    </div>}

    {error && <div className="answer-error" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>{error.message}</span>
      {error.code === "AI_DISABLED" || error.code === "BUDGET"
        ? <button className="text-button" onClick={onSettings}>설정 열기</button>
        : <button className="text-button" onClick={again}><RefreshCw size={12} />다시 시도</button>}
    </div>}

    {answer && <>
      {answer.insufficient && <p className="answer-insufficient" role="note">
        <TriangleAlert size={13} aria-hidden="true" />
        <span>서고 본문만으로는 충분히 답하기 어렵습니다.{answer.missing ? ` ${answer.missing}` : ""}</span>
      </p>}
      {!!paragraphs.length && <article className="answer-text">
        {paragraphs.map((statements, i) => <p key={i}>{statements.map((s, j) => <Statement key={j} statement={s} onCite={cite} />)}</p>)}
      </article>}
      <p className="answer-meta">
        <span>인용 {answer.refs.length}개 · 검토한 구절 {(answer.refs.length + answer.unused.length).toLocaleString()}개</span>
        {answer.dropped > 0 && <span title="AI가 붙인 인용문이 그 구절에 없어서 인용에서 뺐습니다.">확인되지 않은 인용 {answer.dropped}개 제외</span>}
        <span title={answer.queries.join("\n")}>검색어 {answer.queries.length}개</span>
        <span>{PROVIDERS[answer.provider] || answer.provider}{answer.model ? ` · ${answer.model}` : ""} · {Math.max(1, Math.round(answer.elapsedMs / 1000))}초</span>
        {answer.coverage.docs < answer.coverage.total && <span>본문 색인 {answer.coverage.docs.toLocaleString()}/{answer.coverage.total.toLocaleString()}편</span>}
        <button className="text-button" onClick={again}><RefreshCw size={12} />다시 답하기</button>
      </p>
      {!!answer.refs.length && <section aria-label="근거 구절">
        <h3 className="answer-heading">근거 구절</h3>
        <ol className="answer-refs">
          {answer.refs.map((ref: AnswerRef) => <Evidence key={ref.n} hit={ref.hit} n={ref.n} quotes={ref.quotes} focused={focused === ref.n}
            onOpen={() => open(ref.hit)} onInspect={() => onInspect(ref.hit.workId)} />)}
        </ol>
      </section>}
      {!!answer.unused.length && <details className="answer-unused">
        <summary>인용하지 않은 구절 {answer.unused.length}개</summary>
        <ol className="answer-refs">
          {answer.unused.map((hit) => <Evidence key={hit.passageId} hit={hit} quotes={[]} focused={false} onOpen={() => open(hit)} onInspect={() => onInspect(hit.workId)} />)}
        </ol>
      </details>}
    </>}
  </div>;
}
