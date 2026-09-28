import { useState, useEffect } from "react";
import { FileText, FolderOpen, Upload, Plus, Download } from "lucide-react";
import type {
  Collection,
  ImportPreview,
  ImportResult,
  Work,
  SeedProfile,
  Run,
} from "../../shared/types";
import { Modal } from "./Modal";
import type { Input } from "../../shared/contracts";
type Common = { onClose: () => void; onError: (error: unknown) => void };
export function ImportDialog({
  projectId,
  collections,
  onImported,
  onRun,
  ...common
}: Common & {
  projectId: string;
  collections: Collection[];
  onImported: (result: ImportResult) => void;
  onRun: (run: Run) => void;
}) {
  const [tab, setTab] = useState("bib"),
    [text, setText] = useState(""),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [result, setResult] = useState<ImportResult | null>(null),
    [busy, setBusy] = useState(false),
    [collectionId, setCollectionId] = useState(""),
    [mode, setMode] = useState<"managed" | "linked" | "metadata">("managed"),
    [folders, setFolders] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      common.onError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="기존 문헌 가져오기" onClose={common.onClose} wide>
      <div className="tabs">
        <button
          className={tab === "bib" ? "active" : ""}
          onClick={() => setTab("bib")}
        >
          <FileText size={15} />
          BibTeX
        </button>
        <button
          className={tab === "pdf" ? "active" : ""}
          onClick={() => setTab("pdf")}
        >
          <FolderOpen size={15} />
          PDF 파일·폴더
        </button>
      </div>
      <label className="field">
        대상 컬렉션
        <select
          value={collectionId}
          onChange={(e) => setCollectionId(e.target.value)}
        >
          <option value="">검토 대기함</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {tab === "bib" ? (
        <>
          <div className="inline-actions">
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const p = await window.bunny.chooseBib({});
                  if (p) {
                    setPreview(p);
                    setResult(null);
                  }
                })
              }
            >
              <Upload size={15} /> .bib 파일 선택
            </button>
            <span className="subtle">또는 아래에 BibTeX를 붙여넣으세요.</span>
          </div>
          <textarea
            className="bib-input"
            spellCheck={false}
            placeholder={
              "@article{citekey,\n  title = {Paper title},\n  author = {Family, Given},\n  year = {2025}\n}"
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
              setResult(null);
            }}
          />
          {preview && (
            <div className="import-preview">
              <p>
                <strong>{preview.items.length}개 엔트리</strong> · 신규{" "}
                {preview.items.filter((i) => i.status === "new").length} · 기존
                연결{" "}
                {preview.items.filter((i) => i.status === "existing").length} ·
                확인 필요{" "}
                {
                  preview.items.filter((i) =>
                    ["error", "conflict"].includes(i.status),
                  ).length
                }
              </p>
              <div className="preview-list">
                {preview.items.map((i, n) => (
                  <div key={n}>
                    <span
                      className={
                        "badge " +
                        (["error", "conflict"].includes(i.status)
                          ? "warning"
                          : "")
                      }
                    >
                      {
                        {
                          new: "신규",
                          existing: "연결",
                          error: "오류",
                          conflict: "충돌",
                        }[i.status]
                      }
                    </span>
                    <span>
                      {i.title}
                      <small>{i.message}</small>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result && (
            <p className="notice" role="status">
              신규 {result.added}편 · 기존 연결 {result.linked}편 · 실패{" "}
              {result.errors.length}건
              {result.errors.map((e) => (
                <span key={e.name} className="block">
                  {e.name}: {e.message}
                </span>
              ))}
            </p>
          )}
          <footer className="modal-footer">
            <button onClick={common.onClose}>{result ? "완료" : "닫기"}</button>
            {!preview ? (
              <button
                className="primary"
                disabled={busy || !text.trim()}
                onClick={() =>
                  void run(async () =>
                    setPreview(await window.bunny.previewBib({ text })),
                  )
                }
              >
                가져오기 미리보기
              </button>
            ) : (
              <button
                className="primary"
                disabled={
                  busy ||
                  !!result ||
                  !preview.items.some((i) =>
                    ["new", "existing"].includes(i.status),
                  )
                }
                onClick={() =>
                  void run(async () => {
                    const r = await window.bunny.importBib({
                      projectId,
                      token: preview.token,
                      collectionId: collectionId || undefined,
                    });
                    setResult(r);
                    common.onError(null);
                    onImported(r);
                  })
                }
              >
                {busy ? "가져오는 중…" : "확인된 문헌 가져오기"}
              </button>
            )}
          </footer>
        </>
      ) : (
        <>
          <p className="subtle">
            원본은 유지합니다. PDF의 메타데이터와 첫 페이지로 서지를 확인하며,
            일치하지 않는 파일도 검토 대기함에 보존합니다.
          </p>
          <div className="radio-list">
            {(
              [
                [
                  "managed",
                  "앱 관리 폴더에 복사",
                  "원본과 독립적으로 보관합니다.",
                ],
                [
                  "linked",
                  "기존 위치에 연결",
                  "원본을 이동하면 다시 연결해야 합니다.",
                ],
                [
                  "metadata",
                  "서지정보만 가져오기",
                  "PDF 첨부는 만들지 않습니다.",
                ],
              ] as const
            ).map(([v, label, desc]) => (
              <label key={v}>
                <input
                  type="radio"
                  name="pdf-mode"
                  checked={mode === v}
                  onChange={() => setMode(v)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{desc}</small>
                </span>
              </label>
            ))}
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={folders}
              onChange={(e) => setFolders(e.target.checked)}
            />
            하위 폴더 이름으로 컬렉션 만들기
          </label>
          <div className="pdf-drop-hint">
            <FileText size={38} strokeWidth={1} />
            <p>여러 PDF 파일 또는 폴더를 선택하세요. 폴더 안의 PDF도 함께 가져옵니다.</p>
            <div className="inline-actions">
              {[false, true].map((folder) => (
                <button
                  key={String(folder)}
                  disabled={busy}
                  className={!folder ? "primary" : ""}
                  onClick={() =>
                    void run(async () => {
                      const r = await window.bunny.choosePdf({
                        projectId,
                        folder,
                        mode,
                        collectionId: collectionId || undefined,
                        mapFolders: folders,
                      });
                      if (r) {
                        onRun(r);
                        common.onClose();
                      }
                    })
                  }
                >
                  {folder ? <FolderOpen size={16} /> : <Plus size={16} />}{" "}
                  {folder ? "폴더 선택" : "PDF 선택"}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
export function WorkEditor({
  work,
  projectId,
  onSaved,
  ...common
}: Common & { work?: Work; projectId: string; onSaved: (work: Work) => void }) {
  const [value, setValue] = useState({
      title: work?.title || "",
      authors: work?.authors.join("\n") || "",
      year: work?.year?.toString() || "",
      doi: work?.doi || "",
      venue: work?.venue || "",
      type: work?.type || "article",
      volume: work?.volume || "",
      issue: work?.issue || "",
      pages: work?.pages || "",
      publisher: work?.publisher || "",
      abstract: work?.abstract || "",
    }),
    [busy, setBusy] = useState(false);
  const field = (key: keyof typeof value, label: string) => (
    <label className="field" key={key}>
      {label}
      <input
        value={value[key]}
        onChange={(e) => setValue({ ...value, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <Modal
      title={work ? "서지정보 수정" : "문헌 직접 등록"}
      onClose={common.onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          const patch = {
            ...value,
            authors: value.authors
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            year: value.year ? Number(value.year) : null,
            doi: value.doi || null,
            abstract: value.abstract || null,
          };
          void (
            work
              ? window.bunny.editWork({ workId: work.id, patch })
              : window.bunny.manualWork({ projectId, metadata: patch })
          )
            .then((w) => {
              onSaved(w);
              common.onClose();
            })
            .catch(common.onError)
            .finally(() => setBusy(false));
        }}
      >
        {field("title", "제목")}
        <label className="field">
          저자 (한 줄에 한 명, 성, 이름)
          <textarea
            rows={3}
            value={value.authors}
            onChange={(e) => setValue({ ...value, authors: e.target.value })}
          />
        </label>
        <div className="form-grid">
          {field("year", "연도")}
          {field("doi", "DOI")}
          {field("venue", "학술지·발행처")}
          {field("type", "문헌 유형")}
          {field("volume", "권")}
          {field("issue", "호")}
          {field("pages", "페이지")}
          {field("publisher", "출판사")}
        </div>
        <label className="field">
          초록
          <textarea
            rows={5}
            value={value.abstract}
            onChange={(e) => setValue({ ...value, abstract: e.target.value })}
          />
        </label>
        <p className="subtle">
          수정값은 원본 메타데이터와 별도로 보존됩니다. 이후 API 갱신에도
          유지됩니다.
        </p>
        <footer className="modal-footer">
          <button type="button" onClick={common.onClose}>
            취소
          </button>
          <button
            className="primary"
            disabled={busy || !value.title.trim()}
            type="submit"
          >
            {busy ? "저장 중…" : "문헌 저장"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function SeedDialog({
  projectId,
  selected,
  profile,
  history,
  question,
  onSaved,
  ...common
}: Common & {
  projectId: string;
  selected: string[];
  profile: SeedProfile | null;
  history: SeedProfile[];
  question: string;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState(selected.length ? "replace" : "keep"),
    [q, setQ] = useState(profile?.question || question),
    [group, setGroup] = useState(""),
    [busy, setBusy] = useState(false),
    [labels, setLabels] = useState<Record<string, string>>({});
  const ids =
    mode === "replace"
      ? selected
      : mode === "add"
        ? [...new Set([...(profile?.ids || []), ...selected])]
        : mode === "remove"
          ? (profile?.ids || []).filter((id) => !selected.includes(id))
          : profile?.ids || [];
  useEffect(() => {
    void Promise.all(
      [...new Set([...selected, ...(profile?.ids || [])])].map((id) =>
        window.bunny.inspect({ projectId, workId: id }),
      ),
    )
      .then((works) =>
        setLabels(Object.fromEntries(works.map((w) => [w.id, w.title]))),
      )
      .catch(common.onError);
  }, [projectId]);
  return (
    <Modal title="초기 관심 기준 변경" onClose={common.onClose} wide>
      <p className="subtle">
        이 기준은 다음 탐색에서도 유지됩니다. 화면 선택이나 저장만으로는 바뀌지
        않습니다.
      </p>
      <label className="field">
        연구 질문
        <textarea rows={3} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <div className="inline-actions">
        <select
          aria-label="seed 변경 방법"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="keep">현재 seed 유지</option>
          <option value="replace" disabled={!selected.length}>
            선택 {selected.length}편으로 교체
          </option>
          <option value="add" disabled={!selected.length}>
            선택 문헌 추가
          </option>
          <option value="remove" disabled={!selected.length}>
            선택 문헌 제거
          </option>
        </select>
        <strong>변경 후 {ids.length}편</strong>
      </div>
      <div className="seed-list">
        {ids.map((id, i) => (
          <div key={id}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            {labels[id] || id}
          </div>
        ))}
      </div>
      <label className="field">
        선택 문헌의 관심 갈래 (선택)
        <input
          placeholder="예: interoception"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        />
      </label>
      {history.length > 0 && (
        <details>
          <summary>기준 변경 이력 ({history.length})</summary>
          {history.map((s) => (
            <p className="subtle" key={s.id}>
              v{s.version} · {s.ids.length}편 ·{" "}
              {new Date(s.createdAt).toLocaleString()} · {s.question}
            </p>
          ))}
        </details>
      )}
      <footer className="modal-footer">
        <button onClick={common.onClose}>취소</button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            const groups = { ...profile?.groups };
            for (const key of Object.keys(groups))
              groups[key] = groups[key].filter((id) => ids.includes(id));
            if (group.trim())
              groups[group.trim()] = selected.filter((id) => ids.includes(id));
            void window.bunny
              .setSeeds({ projectId, ids, question: q, groups })
              .then(() => {
                onSaved();
                common.onClose();
              })
              .catch(common.onError)
              .finally(() => setBusy(false));
          }}
        >
          관심 기준 저장
        </button>
      </footer>
    </Modal>
  );
}
export function ExportDialog({
  projectId,
  selected,
  visibleIds,
  collectionId,
  collections,
  archiveCount: _archiveCount,
  onDone,
  ...common
}: Common & {
  projectId: string;
  selected: string[];
  visibleIds: string[];
  collectionId?: string;
  collections: Collection[];
  archiveCount: number;
  onDone: (message: string) => void;
}) {
  const [scope, setScope] = useState<
      "selected" | "project" | "all" | "collection" | "filtered"
    >(selected.length ? "selected" : "project"),
    [notes, setNotes] = useState(false),
    [files, setFiles] = useState(false),
    [collection, setCollection] = useState(
      collectionId || collections[0]?.id || "",
    ),
    [busy, setBusy] = useState(false);
  // Compare the actual export target, not array identities replaced by list refreshes.
  const previewRequest = JSON.stringify({
    projectId,
    scope: scope === "filtered" ? "selected" : scope,
    ids: scope === "filtered" ? visibleIds : scope === "selected" ? selected : [],
    collectionId: scope === "collection" ? collection || undefined : undefined,
  } satisfies Input<"exportPreview">);
  const [preview, setPreview] = useState<{
    request: string;
    ids: string[];
  } | null>(null);
  const onError = common.onError;
  useEffect(() => {
    let valid = true;
    const request = JSON.parse(previewRequest) as Input<"exportPreview">;
    if (request.scope === "collection" && !request.collectionId) {
      setPreview({ request: previewRequest, ids: [] });
      return;
    }
    void window.bunny
      .exportPreview(request)
      .then((r) => {
        if (valid) setPreview({ request: previewRequest, ids: r.ids });
      })
      .catch((error: unknown) => {
        if (valid) onError(error);
      });
    return () => {
      valid = false;
    };
  }, [previewRequest, onError]);
  const previewIds = preview?.request === previewRequest ? preview.ids : null;
  const count = previewIds?.length ?? null;
  return (
    <Modal title="BibTeX 내보내기" onClose={common.onClose}>
      <label className="field">
        범위
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as typeof scope)}
        >
          <option value="selected">선택한 문헌 · 숨겨진 선택 포함</option>
          <option value="filtered">현재 필터 결과 · 조회한 문헌</option>
          <option value="project">현재 프로젝트 아카이브</option>
          <option value="collection">컬렉션</option>
          <option value="all">모든 프로젝트 아카이브</option>
        </select>
      </label>
      {scope === "collection" && (
        <select
          aria-label="내보낼 컬렉션"
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
        >
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <p className="export-count" role="status" aria-live="polite">
        {count !== null ? (
          <span>
            <strong>{count}</strong>편
          </span>
        ) : (
          "내보낼 문헌 확인 중…"
        )}
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={notes}
          onChange={(e) => setNotes(e.target.checked)}
        />
        비공개 노트·태그 포함
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={files}
          onChange={(e) => setFiles(e.target.checked)}
        />
        이 Mac의 PDF 절대 경로 포함
      </label>
      <p className="subtle">
        기본 내보내기는 서지정보만 포함합니다. 선택한 후보는 저장하지 않고도
        내보낼 수 있습니다.
      </p>
      <footer className="modal-footer">
        <button onClick={common.onClose}>취소</button>
        <button
          className="primary"
          disabled={busy || !previewIds || count === 0}
          onClick={() => {
            setBusy(true);
            void window.bunny
              .exportBib({
                projectId,
                scope: "selected",
                ids: previewIds || [],
                collectionId: collection || undefined,
                includeNotes: notes,
                includeFiles: files,
              })
              .then((r) => {
                if (r) {
                  onDone(`${r.count}편 내보냄 · ${r.path}`);
                  common.onClose();
                }
              })
              .catch(common.onError)
              .finally(() => setBusy(false));
          }}
        >
          <Download size={15} />
          파일 저장
        </button>
      </footer>
    </Modal>
  );
}
