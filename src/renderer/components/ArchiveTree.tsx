import { useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, Folder, Inbox } from "lucide-react";
import type { ArchiveClassification } from "../../shared/types";

export function ArchiveTree({ classification, count, scope, scopeId, navigate }: {
  classification: ArchiveClassification;
  count: number;
  scope: string;
  scopeId: string;
  navigate: (scope: "archive" | "topic" | "unclassified", id?: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return <div className="archive-tree">
    <div className={`archive-root ${scope === "archive" ? "active" : ""}`}>
      <button className="icon-button" aria-label={open ? "아카이브 접기" : "아카이브 펼치기"} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron size={14} />
      </button>
      <button aria-current={scope === "archive" ? "page" : undefined} onClick={() => navigate("archive")}>
        <BookOpen size={17} /><span>내 아카이브</span><span className="nav-count">{count}</span>
      </button>
    </div>
    {open && <div className="archive-branches" aria-label="아카이브 소주제">
      {classification.topics.map(topic => <button key={topic.id}
        className={scope === "topic" && scopeId === topic.id ? "active" : ""}
        aria-current={scope === "topic" && scopeId === topic.id ? "page" : undefined}
        title={`${topic.name}\n${topic.description}`}
        onClick={() => navigate("topic", topic.id)}>
        <Folder size={15} style={{ color: topic.color }} /><span className="topic-name">{topic.name}</span><span className="nav-count">{topic.count}</span>
      </button>)}
      {(classification.unclassified > 0 || !classification.topics.length || scope === "unclassified") && <button
        className={scope === "unclassified" ? "active" : ""}
        aria-current={scope === "unclassified" ? "page" : undefined}
        onClick={() => navigate("unclassified")}>
        <Inbox size={15} /><span className="topic-name">미분류</span><span className="nav-count">{classification.unclassified}</span>
      </button>}
    </div>}
  </div>;
}
