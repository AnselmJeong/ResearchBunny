import { randomUUID } from "node:crypto";
import type { ChatContextRef, ChatSession, ChatThreadSummary } from "../../shared/chat";
import { chatScope } from "../../shared/chat";
import { AppError, now } from "../../shared/types";
import type { Library } from "../db/database";

export function visibleSession(session: ChatSession): ChatSession {
  return structuredClone({ ...session, messages: session.messages.map(message => {
    const visible = { ...message };
    delete visible.context;
    return visible;
  }) });
}

/** SQLite owns both the current thread pointer and every previous conversation. */
export class ChatStore {
  constructor(private db: Library) {}
  private scope(projectId: string, workId: string, context: ChatContextRef) {
    return JSON.stringify([projectId, workId, chatScope(context)]);
  }
  create(projectId: string, workId: string, context: ChatContextRef): ChatSession {
    const session: ChatSession = { threadId: randomUUID(), projectId, workId, context, messages: [], activeRequestId: null, phase: "", revision: 0, createdAt: now() };
    this.db.transaction(() => {
      this.save(session);
      this.db.db.prepare("INSERT OR REPLACE INTO chat_heads VALUES(?,?)").run(this.scope(projectId, workId, context), session.threadId);
    });
    return session;
  }
  load(projectId: string, workId: string, context: ChatContextRef, threadId?: string): ChatSession {
    if (!threadId) {
      const row = this.db.db.prepare("SELECT thread_id FROM chat_heads WHERE scope=?").get(this.scope(projectId, workId, context)) as { thread_id: string } | undefined;
      threadId = row?.thread_id;
      if (!threadId) {
        return this.db.transaction(() => {
          const session = this.create(projectId, workId, context);
          // The old key is retained as recovery evidence; the head prevents repeated imports.
          const legacy = context.kind === "abstract" ? this.db.pref<ChatSession>(`article-chat:${JSON.stringify([projectId, workId])}`) : undefined;
          if (legacy) { Object.assign(session, { messages: legacy.messages, activeRequestId: legacy.activeRequestId, phase: legacy.phase, revision: legacy.revision }); this.save(session); }
          return session;
        });
      }
    }
    const row = this.db.db.prepare("SELECT data FROM chat_threads WHERE id=? AND project_id=? AND work_id=? AND context_key=?").get(threadId, projectId, workId, chatScope(context)) as { data: string } | undefined;
    if (!row) throw new AppError("CHAT_THREAD", "이 문맥에 속한 대화를 찾을 수 없습니다.");
    return JSON.parse(row.data);
  }
  save(session: ChatSession) {
    this.db.transaction(() => {
      this.db.db.prepare("INSERT INTO chat_threads(id,project_id,work_id,context_key,updated_at,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data")
        .run(session.threadId, session.projectId, session.workId, chatScope(session.context), now(), JSON.stringify(visibleSession(session)));
      for (const message of session.messages) if (message.context) {
        this.db.db.prepare("INSERT OR IGNORE INTO chat_contexts(thread_id,message_id,data) VALUES(?,?,?)").run(session.threadId, message.id, JSON.stringify(message.context));
      }
    });
    // Context evidence is immutable and stored once, never retransmitted on each chunk.
    for (const message of session.messages) delete message.context;
  }
  select(session: ChatSession) {
    this.db.db.prepare("INSERT OR REPLACE INTO chat_heads VALUES(?,?)").run(this.scope(session.projectId, session.workId, session.context), session.threadId);
  }
  list(projectId: string, workId: string, context: ChatContextRef): ChatThreadSummary[] {
    this.load(projectId, workId, context);
    const rows = this.db.db.prepare("SELECT data,updated_at FROM chat_threads WHERE project_id=? AND work_id=? AND context_key=? ORDER BY updated_at DESC, rowid DESC").all(projectId, workId, chatScope(context)) as { data: string; updated_at: string }[];
    return rows.map(row => { const s: ChatSession = JSON.parse(row.data); return { threadId: s.threadId, title: s.messages.find(m => m.role === "user")?.content.slice(0, 70) || "새 대화", createdAt: s.createdAt, updatedAt: row.updated_at, messageCount: s.messages.length }; });
  }
}
