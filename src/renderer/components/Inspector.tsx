import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronRight,
  Edit3,
  FileText,
  FolderOpen,
  Link,
  Plus,
  Star,
  X,
} from "lucide-react";
import type {
  WorkView,
  Attachment,
  Collection,
  DiscoveryMode,
  ReadState,
} from "../../shared/types";
export function Inspector({
  work,
  projectId,
  collections,
  note,
  noteStatus,
  onNote,
  onPatch,
  onClose,
  onEdit,
  onDiscover,
  onError,
  onInspect,
  seed,
}: {
  work: WorkView | null;
  projectId: string;
  collections: Collection[];
  note: string;
  noteStatus: string;
  onNote: (text: string) => void;
  onPatch: (patch: Partial<WorkView["state"]>) => void;
  onClose: () => void;
  onEdit: () => void;
  onDiscover: (mode: DiscoveryMode, ids: string[]) => void;
  onError: (error: unknown) => void;
  onInspect: (id: string) => void;
  seed: boolean;
}) {
  const [attachments, setAttachments] = useState<Attachment[]>([]),
    [duplicates, setDuplicates] = useState<WorkView[] | null>(null),
    [tags, setTags] = useState(""),
    [evidenceTitles, setEvidenceTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    setDuplicates(null);
    setAttachments([]);
    setTags(work?.state.tags.join(", ") || "");
    if (work)
      void window.bunny
        .attachments({ workId: work.id })
        .then(setAttachments)
        .catch(onError);
  }, [work?.id, work?.attachmentCount]);
  useEffect(() => {
    if (!work?.evidence) return;
    void Promise.all(
      work.evidence.seedIds.map((workId) =>
        window.bunny.inspect({ projectId, workId }),
      ),
    )
      .then((works) =>
        setEvidenceTitles(
          Object.fromEntries(works.map((w) => [w.id, w.title])),
        ),
      )
      .catch(() => {});
  }, [work?.id, work?.evidence?.seedIds.join(",")]);
  if (!work)
    return (
      <aside className="inspector empty-inspector">
        <BookOpen size={28} strokeWidth={1} />
        <p>
          논문을 선택하면
          <br />
          서지정보와 초록을 확인할 수 있습니다.
        </p>
        <span>
          선택한 문헌만 저장하고
          <br />
          관심 기준은 따로 관리하세요.
        </span>
      </aside>
    );
  const state = work.state;
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <span>문헌 상세</span>
        <button className="icon-button" title="상세 닫기" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="inspector-scroll">
        <div className="paper-kicker">
          <span>{work.type}</span>
          <span>{work.year || "연도 미상"}</span>
          {seed && <span className="badge">◆ 초기 seed</span>}
        </div>
        <h2>{work.title}</h2>
        <p className="authors">{work.authors.join(" · ") || "저자 미상"}</p>
        <p className="venue">
          {work.venue || "발행처 미상"}
          {work.volume && ` · ${work.volume}`}
          {work.pages && ` · ${work.pages}`}
        </p>
        <div className="paper-actions">
          <button
            className={
              state.screening === "included" ? "saved-button" : "primary"
            }
            onClick={() =>
              onPatch({
                screening:
                  state.screening === "included" ? "pending" : "included",
              })
            }
          >
            {state.screening === "included" ? (
              <Check size={15} />
            ) : (
              <Bookmark size={15} />
            )}{" "}
            {state.screening === "included"
              ? "아카이브 저장됨"
              : "아카이브에 저장"}
          </button>
          <button
            title="핵심 표시"
            className={"icon-button " + (state.starred ? "active" : "")}
            onClick={() => onPatch({ starred: !state.starred })}
          >
            <Star size={17} fill={state.starred ? "currentColor" : "none"} />
          </button>
          <button
            title="서지정보 수정"
            className="icon-button"
            onClick={onEdit}
          >
            <Edit3 size={16} />
          </button>
        </div>
        {work.retracted && (
          <p className="warning-text">공급자가 철회 논문으로 표시했습니다.</p>
        )}
        <div className="paper-stats">
          <div>
            <strong>{work.citations?.toLocaleString() ?? "미상"}</strong>
            <span>전역 피인용수</span>
          </div>
          <div>
            <strong>{work.references?.length ?? "미조회"}</strong>
            <span>확인된 참고문헌</span>
          </div>
          <div>
            <strong>{attachments.length}</strong>
            <span>보관 PDF</span>
          </div>
        </div>
        <div className="paper-links">
          {work.doi && (
            <button
              onClick={() =>
                void window.bunny
                  .openExternal({ workId: work.id, kind: "doi" })
                  .catch(onError)
              }
            >
              <Link size={13} />
              DOI <ArrowUpRight size={13} />
            </button>
          )}
          {work.url && (
            <button
              onClick={() =>
                void window.bunny
                  .openExternal({ workId: work.id, kind: "source" })
                  .catch(onError)
              }
            >
              원문 페이지 <ArrowUpRight size={13} />
            </button>
          )}
          {work.oaUrl && (
            <button
              onClick={() =>
                void window.bunny
                  .openExternal({ workId: work.id, kind: "oa" })
                  .catch(onError)
              }
            >
              Open access <ArrowUpRight size={13} />
            </button>
          )}
        </div>
        <section>
          <h3>초록</h3>
          {work.abstract ? (
            <p className="abstract">{work.abstract}</p>
          ) : (
            <p className="missing">
              제공된 초록이 없습니다. 제목과 주제·인용 관계만 확인할 수
              있습니다.
            </p>
          )}
        </section>
        {work.evidence && work.evidence.relation !== "local" && (
          <section>
            <h3>발견 근거</h3>
            {work.evidence.ai && (
              <div className="ai-reason">
                <span className="badge">{work.evidence.ai.role} · AI 추정</span>
                <p>{work.evidence.ai.reason}</p>
                <blockquote>{work.evidence.ai.quote}</blockquote>
                <small>{work.evidence.ai.limitation}</small>
              </div>
            )}
            <ul className="evidence-list">
              {[...work.evidence.origins, ...work.evidence.reasons].map(
                (reason, i) => (
                  <li key={i}>{reason}</li>
                ),
              )}
            </ul>
            {work.evidence.hidden.length > 0 && (
              <p className="warning-text">
                숨긴 이유: {work.evidence.hidden.join(" · ")}
              </p>
            )}
            {work.evidence.seedIds.length > 0 && (
              <details>
                <summary>
                  연결 근거 문헌 {work.evidence.seedIds.length}/
                  {work.evidence.denominator}편
                </summary>
                {work.evidence.seedIds.map((id) => (
                  <button
                    className="evidence-paper"
                    key={id}
                    onClick={() => onInspect(id)}
                  >
                    {evidenceTitles[id] || id}
                    <ChevronRight size={13} />
                  </button>
                ))}
              </details>
            )}
            {work.evidence.sharedIds.length > 0 && (
              <details>
                <summary>공유 참고문헌 ID</summary>
                <p className="subtle">{work.evidence.sharedIds.join(", ")}</p>
              </details>
            )}
            {!!work.evidence.coCitingIds?.length && (
              <details>
                <summary>공동인용 근거 문헌 ID</summary>
                <p className="subtle">{work.evidence.coCitingIds.join(", ")}</p>
              </details>
            )}
            <p className="subtle">{work.evidence.scope}</p>
          </section>
        )}
        <section>
          <h3>라이브러리</h3>
          <label className="field">
            읽기 상태
            <select
              value={state.reading}
              onChange={(e) =>
                onPatch({ reading: e.target.value as ReadState })
              }
            >
              <option value="unread">미열람</option>
              <option value="planned">읽을 예정</option>
              <option value="reading">읽는 중</option>
              <option value="read">읽음</option>
            </select>
          </label>
          <label className="field">
            컬렉션
            <select
              aria-label="문헌을 컬렉션에 추가"
              value=""
              onChange={(e) => {
                if (e.target.value)
                  void window.bunny
                    .collectionMembers({
                      projectId,
                      collectionId: e.target.value,
                      ids: [work.id],
                    })
                    .catch(onError);
              }}
            >
              <option value="">컬렉션에 추가…</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="collection-chips">
            {collections
              .filter((c) => work.collectionIds.includes(c.id))
              .map((c) => (
                <button
                  key={c.id}
                  title="컬렉션에서 제거"
                  onClick={() =>
                    void window.bunny
                      .collectionMembers({
                        projectId,
                        collectionId: c.id,
                        ids: [work.id],
                        remove: true,
                      })
                      .catch(onError)
                  }
                >
                  {c.name}
                  <X size={11} />
                </button>
              ))}
          </div>
          <label className="field">
            태그
            <input
              placeholder="쉼표로 구분"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onBlur={() => {
                const values = tags
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (values.join(",") !== state.tags.join(","))
                  onPatch({ tags: values });
              }}
            />
          </label>
          <div className="note-heading">
            <h3>노트</h3>
            <span className="subtle" role="status">
              {noteStatus}
            </span>
          </div>
          <textarea
            className="note-input"
            aria-label="문헌 노트"
            placeholder="왜 이 논문을 저장했나요?"
            value={note}
            onChange={(e) => onNote(e.target.value)}
            rows={5}
          />
        </section>
        <section>
          <div className="note-heading">
            <h3>첨부 파일</h3>
            <button
              className="text-button"
              onClick={() =>
                void window.bunny
                  .choosePdf({ projectId, workId: work.id })
                  .catch(onError)
              }
            >
              <Plus size={14} />
              PDF
            </button>
          </div>
          {attachments.length ? (
            attachments.map((a) => (
              <div className="attachment" key={a.id}>
                <FileText size={19} />
                <div>
                  <button
                    onClick={() =>
                      void window.bunny
                        .attachmentAction({
                          attachmentId: a.id,
                          action: "open",
                        })
                        .catch(onError)
                    }
                  >
                    {a.name}
                  </button>
                  <small>
                    {a.exists
                      ? `${(a.size / 1024 / 1024).toFixed(1)} MB · ${a.mode === "managed" ? "관리 복사" : "외부 연결"}`
                      : "파일 연결 끊김"}{" "}
                    · {a.status}
                  </small>
                  <div className="inline-actions">
                    <button
                      className="text-button"
                      onClick={() =>
                        void window.bunny
                          .attachmentAction({
                            attachmentId: a.id,
                            action: "reveal",
                          })
                          .catch(onError)
                      }
                    >
                      <FolderOpen size={12} />
                      Finder
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        void window.bunny
                          .attachmentAction({
                            attachmentId: a.id,
                            action: "relink",
                          })
                          .then(() =>
                            window.bunny
                              .attachments({ workId: work.id })
                              .then(setAttachments),
                          )
                          .catch(onError)
                      }
                    >
                      재연결
                    </button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="subtle">연결된 PDF가 없습니다.</p>
          )}
        </section>
        <section>
          <h3>메타데이터 출처</h3>
          <p className="subtle">
            {work.source} · {new Date(work.fetchedAt).toLocaleString()}
            <br />
            {work.doi || work.openalex || "외부 식별자 미확인"}
            <br />
            Citekey: {work.citekey}
          </p>
          {Object.keys(work.edits).length > 0 && (
            <details>
              <summary>수정한 필드 {Object.keys(work.edits).length}개</summary>
              <p className="subtle">
                {Object.keys(work.edits).join(", ")} · 공급자 원본은 별도
                보존됩니다.
              </p>
            </details>
          )}
          <button
            className="text-button"
            onClick={() =>
              void window.bunny
                .duplicates({ workId: work.id })
                .then(setDuplicates)
                .catch(onError)
            }
          >
            중복 후보 확인
          </button>
          {duplicates && (
            <div>
              {!duplicates.length ? (
                <p className="subtle">비슷한 제목의 문헌이 없습니다.</p>
              ) : (
                duplicates.map((d) => (
                  <div className="duplicate" key={d.id}>
                    <p>
                      {d.title} ({d.year || "미상"})
                    </p>
                    <small>
                      {d.doi || "DOI 없음"} · {d.type}
                    </small>
                    <button
                      onClick={() => {
                        void window.bunny
                          .merge({ keepId: work.id, removeId: d.id })
                          .then(() => setDuplicates(null))
                          .catch(onError);
                      }}
                    >
                      현재 문헌으로 병합
                    </button>
                  </div>
                ))
              )}
              <button
                className="text-button"
                onClick={() => void window.bunny.undoMerge({}).catch(onError)}
              >
                직전 병합 되돌리기
              </button>
              <p className="subtle">
                preprint·출판본이 다르면 병합하지 마세요. 병합 직후 다른 편집
                전까지 되돌릴 수 있습니다.
              </p>
            </div>
          )}
        </section>
      </div>
      <div className="inspector-footer">
        <button onClick={() => onDiscover("related", [work.id])}>
          관련 논문
        </button>
        <button onClick={() => onDiscover("references", [work.id])}>
          참고문헌
        </button>
        <button onClick={() => onDiscover("citedBy", [work.id])}>
          후속 인용
        </button>
      </div>
    </aside>
  );
}
