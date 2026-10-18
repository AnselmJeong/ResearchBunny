import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { JobStatus, Run } from "../../shared/types";

const STATUS: Partial<Record<JobStatus, string>> = {
  queued: "대기",
  running: "진행 중",
  cancelled: "중단",
  paused_budget: "예산 대기",
  failed: "실패",
  interrupted: "중단됨",
};
const when = (iso: string) => {
  const date = new Date(iso);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

/** 문헌 탐색 start screen: earlier runs to reopen, newest first. */
export function RecentRuns({ runs, label, onOpen, limit = 12 }: {
  runs: Run[];
  label: (run: Run) => string;
  onOpen: (run: Run) => void;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  if (!runs.length) return null;
  return <section className="recent-runs" aria-label="최근 탐색">
    <h3>최근 탐색</h3>
    <ul>
      {(all ? runs : runs.slice(0, limit)).map((run) => {
        const subject = run.import ? "" : run.query || (run.inputIds.length ? `출발 문헌 ${run.inputIds.length}편` : "");
        return <li key={run.id}>
          <button onClick={() => onOpen(run)} title={subject || label(run)}>
            <span className="recent-run-kind">{label(run)}</span>
            <span className="recent-run-subject">{subject}</span>
            <span className="recent-run-meta">
              {run.count.toLocaleString()}편{STATUS[run.status] ? ` · ${STATUS[run.status]}` : ""} · {when(run.createdAt)}
            </span>
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        </li>;
      })}
    </ul>
    {!all && runs.length > limit && <button className="text-button" onClick={() => setAll(true)}>이전 탐색 {(runs.length - limit).toLocaleString()}건 더 보기</button>}
  </section>;
}
