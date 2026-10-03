import { useEffect, useState, type ComponentProps } from "react";
import { BookOpen, Sparkles, X } from "lucide-react";
import { Inspector } from "./Inspector";
import { AISidebar } from "./AISidebar";
import { chatScope, type ChatContextRef } from "../../shared/chat";
import type { Settings } from "../../shared/types";

export function RightPane({ settings, onSettings, onClose, context, ...props }: ComponentProps<typeof Inspector> & { context: ChatContextRef; settings: Settings; onSettings: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<"details" | "ai">(() => { try { return localStorage.getItem("researchbunny.rightPaneTab") === "ai" ? "ai" : "details"; } catch { return "details"; } });
  useEffect(() => { try { localStorage.setItem("researchbunny.rightPaneTab", tab); } catch { /* Optional view preference. */ } }, [tab]);
  return <aside className="right-pane" aria-label="문헌과 AI">
    <header className="right-pane-header">
      <div role="tablist" aria-label="오른쪽 패널">
        {([['details', '문헌 상세', BookOpen], ['ai', 'AI', Sparkles]] as const).map(([key, label, Icon]) =>
          <button key={key} id={`right-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`right-panel-${key}`} tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)} onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "details" : event.key === "End" ? "ai" : tab === "ai" ? "details" : "ai";
              setTab(next); document.getElementById(`right-tab-${next}`)?.focus();
            }}><Icon size={15} />{label}</button>)}
      </div>
      <button className="icon-button" title="오른쪽 패널 닫기" aria-label="오른쪽 패널 닫기" onClick={onClose}><X size={17} /></button>
    </header>
    <div className="right-pane-content" role="tabpanel" id="right-panel-details" aria-labelledby="right-tab-details" hidden={tab !== "details"}>
      <Inspector {...props} />
    </div>
    <div className="right-pane-content" role="tabpanel" id="right-panel-ai" aria-labelledby="right-tab-ai" hidden={tab !== "ai"}>
      <AISidebar key={`${props.projectId}:${props.work?.id ?? "empty"}:${chatScope(context)}`} context={context} work={props.work} projectId={props.projectId} settings={settings} onSettings={onSettings} />
    </div>
  </aside>;
}
