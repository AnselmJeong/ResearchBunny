import { useState } from "react";
import { GitBranch } from "lucide-react";
import { Modal } from "./Modal";
import { GenealogySettingsForm } from "./GenealogySettingsForm";
import { defaultGenealogySettings, type Genealogy } from "../../shared/genealogy";
import type { Collection, Settings } from "../../shared/types";

/** Creates a genealogy report for one collection. */
export function GenealogyDialog({
  projectId,
  collection,
  settings,
  question,
  onClose,
  onCreated,
  onError,
}: {
  projectId: string;
  collection: Collection;
  settings: Settings;
  question: string;
  onClose: () => void;
  onCreated: (genealogy: Genealogy) => void;
  onError: (error: unknown) => void;
}) {
  const [title, setTitle] = useState(`${collection.name}의 계보`);
  const [value, setValue] = useState(() => defaultGenealogySettings(settings, question));
  const [workspace, setWorkspace] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="계보 리포트 만들기" onClose={onClose} wide>
      <p className="subtle">
        ‘{collection.name}’ 컬렉션의 {collection.count.toLocaleString()}편에서 시작합니다. 연구 질문이 어떻게 출발해 발전하고 갈라졌는지, 어떤 가지가 막히고 살아남았는지를 장별 원고로
        씁니다. 실행하면 연구 질문과 문헌의 제목·초록·본문 일부를 고른 AI 연결로 보냅니다. 개인 노트는 보내지 않습니다.
      </p>
      <label className="field">
        제목
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <GenealogySettingsForm
        value={value}
        onChange={setValue}
        app={settings}
        workspace={workspace}
        onWorkspace={() =>
          void window.bunny
            .chooseGenealogyFolder({})
            .then((path) => path && setWorkspace(path))
            .catch(onError)
        }
      />
      <div className="modal-footer">
        <button onClick={onClose}>취소</button>
        <button
          className="primary"
          disabled={busy || !title.trim() || !collection.count}
          onClick={() => {
            setBusy(true);
            void window.bunny
              .genealogyCreate({ projectId, collectionId: collection.id, title: title.trim(), settings: value, ...(workspace ? { workspace } : {}) })
              .then(onCreated)
              .catch(onError)
              .finally(() => setBusy(false));
          }}
        >
          <GitBranch size={15} />
          만들기
        </button>
      </div>
    </Modal>
  );
}
