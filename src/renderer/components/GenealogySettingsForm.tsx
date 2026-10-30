import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import {
  PROVIDER_NAMES,
  settingsModel,
  type GenealogyProvider,
  type GenealogySettings,
  type GenealogyStage,
  type ModelRoute,
} from "../../shared/genealogy";
import { CLAUDE_MODELS } from "../../shared/claude";
import type { Settings } from "../../shared/types";

type AppModels = Pick<Settings, "codexModel" | "claudeModel" | "ollamaModel">;

const STAGES: { key: GenealogyStage; label: string; help: string }[] = [
  { key: "light", label: "유형·후보 판정", help: "짧고 많은 호출" },
  { key: "cards", label: "문헌 카드", help: "논문마다 한 번" },
  { key: "write", label: "가지 장부·목차·집필", help: "품질이 결과를 정함" },
];

/** The models each connection offers, asked once while the app runs; a failed request is asked again next time. */
const catalogs = new Map<GenealogyProvider, Promise<string[]>>();
function useModels(provider: GenealogyProvider) {
  const [models, setModels] = useState<string[]>(provider === "claude" ? [...CLAUDE_MODELS] : []);
  useEffect(() => {
    if (provider === "claude") {
      setModels([...CLAUDE_MODELS]);
      return;
    }
    setModels([]);
    let current = true;
    let catalog = catalogs.get(provider);
    if (!catalog) {
      catalog = (provider === "codex" ? window.bunny.codexModels({}).then((list) => list.map((m) => m.id)) : window.bunny.ollamaModels({})).catch(() => {
        catalogs.delete(provider);
        return [];
      });
      catalogs.set(provider, catalog);
    }
    void catalog.then((list) => current && setModels(list));
    return () => {
      current = false;
    };
  }, [provider]);
  return models;
}

const MODEL_NAMES: Record<string, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

function RouteField({ stage, value, onChange, app }: { stage: (typeof STAGES)[number]; value: ModelRoute; onChange: (route: ModelRoute) => void; app: AppModels }) {
  const models = useModels(value.provider);
  const fromSettings = settingsModel(app, value.provider);
  const follow = fromSettings ? (MODEL_NAMES[fromSettings] ?? fromSettings) : value.provider === "ollama" ? "모델 미지정" : "계정 기본 모델";
  return (
    <div className="genealogy-route">
      <span>
        {stage.label}
        <small> · {stage.help}</small>
      </span>
      <select
        aria-label={`${stage.label} 연결`}
        value={value.provider}
        onChange={(e) => onChange({ provider: e.target.value as GenealogyProvider, model: "" })}
      >
        {(Object.keys(PROVIDER_NAMES) as GenealogyProvider[]).map((p) => (
          <option key={p} value={p}>
            {PROVIDER_NAMES[p]}
          </option>
        ))}
      </select>
      <select aria-label={`${stage.label} 모델`} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
        <option value="">설정에 따름 · {follow}</option>
        {value.model && !models.includes(value.model) && <option value={value.model}>{value.model} · 목록에 없음</option>}
        {models.map((m) => (
          <option key={m} value={m}>
            {MODEL_NAMES[m] ?? m}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The settings of one genealogy report, used when creating it and in its settings tab. */
export function GenealogySettingsForm({
  value,
  onChange,
  workspace,
  onWorkspace,
  app,
}: {
  value: GenealogySettings;
  onChange: (value: GenealogySettings) => void;
  /** The models Settings names, which a stage left on "설정에 따름" uses. */
  app: AppModels;
  /** Shown only when the folder can still be chosen (at creation). */
  workspace?: string;
  onWorkspace?: () => void;
}) {
  const set = <K extends keyof GenealogySettings>(key: K, v: GenealogySettings[K]) => onChange({ ...value, [key]: v });
  return (
    <div className="genealogy-settings">
      <label className="field">
        연구 질문
        <textarea rows={3} value={value.question} onChange={(e) => set("question", e.target.value)} placeholder="이 리포트가 답하려는 질문" />
      </label>
      <label className="field">
        독자
        <input value={value.reader} onChange={(e) => set("reader", e.target.value)} />
        <small>용어를 어디까지 풀어 쓸지 정합니다. 예: 정신과 의사, 이 분야를 처음 시작하는 대학원생</small>
      </label>
      <h3>AI 연결</h3>
      <p className="subtle">단계마다 연결과 모델을 고릅니다. 모델을 고르지 않으면(설정에 따름) 설정 → AI 연결에서 그 연결에 정한 모델을 쓰고, 그 설정을 바꾸면 따라 바뀝니다. 계보 리포트는 구독 연결과 Ollama만 쓰며 유료 API로 넘어가지 않습니다.</p>
      {STAGES.map((stage) => (
        <RouteField key={stage.key} stage={stage} app={app} value={value.routes[stage.key]} onChange={(route) => set("routes", { ...value.routes, [stage.key]: route })} />
      ))}
      <h3>새 논문 자동 반영</h3>
      <label className="field">
        방식
        <select value={value.expansion} onChange={(e) => set("expansion", e.target.value as GenealogySettings["expansion"])}>
          <option value="auto">자동 채택 · 예산 안에서 컬렉션에 넣고 되돌릴 수 있음</option>
          <option value="suggest">제안만 · 채택한 것만 반영</option>
          <option value="off">끄기 · 컬렉션 문헌만 사용</option>
        </select>
      </label>
      <div className="form-grid three">
        <label className="field">
          한 차례 최대
          <input type="number" min={1} max={50} value={value.perRound} onChange={(e) => set("perRound", Number(e.target.value))} />
        </label>
        <label className="field">
          최대 차례
          <input type="number" min={0} max={10} value={value.rounds} onChange={(e) => set("rounds", Number(e.target.value))} />
        </label>
        <label className="field">
          처음 대비 최대 증가(%)
          <input type="number" min={0} max={500} value={Math.round(value.growth * 100)} onChange={(e) => set("growth", Number(e.target.value) / 100)} />
        </label>
      </div>
      <p className="subtle">찾는 순서는 아카이브 → 서고 → OpenAlex입니다. 넣은 논문은 컬렉션과 아카이브에 들어가고, 이유와 근거가 남습니다.</p>
      <h3>진행</h3>
      <label className="check">
        <input type="checkbox" checked={value.pauseAtOutline} onChange={(e) => set("pauseAtOutline", e.target.checked)} />
        목차를 만든 뒤 멈추고 승인을 기다리기
      </label>
      <label className="check">
        <input type="checkbox" checked={value.fetchPdfs} onChange={(e) => set("fetchPdfs", e.target.checked)} />
        PDF가 없는 논문은 원문 확보 작업으로 내려받기
      </label>
      <label className="check">
        <input type="checkbox" disabled={!value.fetchPdfs} checked={value.useBrowser} onChange={(e) => set("useBrowser", e.target.checked)} />
        내려받을 때 앱 전용 Chrome도 사용
      </label>
      <div className="form-grid">
        <label className="field">
          작업당 AI 호출 상한
          <input type="number" min={10} max={5000} value={value.maxCalls} onChange={(e) => set("maxCalls", Number(e.target.value))} />
        </label>
        <label className="field">
          동시에 읽는 논문 수
          <input type="number" min={1} max={8} value={value.concurrency} onChange={(e) => set("concurrency", Number(e.target.value))} />
        </label>
      </div>
      <label className="field">
        인용 양식(CSL) 파일
        <input value={value.csl} onChange={(e) => set("csl", e.target.value)} placeholder="비우면 번호 인용(Vancouver형) 기본 양식" />
      </label>
      {onWorkspace && (
        <div className="field">
          작업 폴더
          <div className="inline-actions">
            <span className="genealogy-path">{workspace || "라이브러리 안 genealogies 폴더"}</span>
            <button type="button" onClick={onWorkspace}>
              <FolderOpen size={14} />
              폴더 고르기
            </button>
          </div>
          <small>카드, 목차, 장별 원고, bib, EPUB·PDF가 이 폴더에 쌓입니다. ScholarPen 프로젝트의 resources/genealogy 아래를 고를 수 있습니다.</small>
        </div>
      )}
    </div>
  );
}
