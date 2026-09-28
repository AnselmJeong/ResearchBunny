import { useEffect, useId, useState } from "react";
import { filtersSchema } from "../../shared/contracts";
import type { Filters as FilterValues } from "../../shared/types";
import { DEFAULT_FILTERS } from "../../shared/types";
// Keep incomplete numeric edits out of list requests and saved navigation.
function NumericFilter({ field, value, onChange, label, min, max, placeholder, step = 1 }: {
  field: "yearFrom" | "yearTo" | "minCitations" | "minShared";
  value: number | null;
  onChange: (value: number | null) => void;
  label: string;
  min: number;
  max: number;
  placeholder?: string;
  step?: number | "any";
}) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const [invalid, setInvalid] = useState(false);
  const hintId = useId();
  useEffect(() => {
    setDraft(String(value ?? ""));
    setInvalid(false);
  }, [value]);
  const parse = (input: HTMLInputElement) => {
    const parsed = filtersSchema.shape[field].safeParse(input.value === "" ? null : Number(input.value));
    return input.validity.valid && parsed.success ? parsed : null;
  };
  return <span className="numeric-filter">
    <input type="number" aria-label={label} min={min} max={max} step={step}
      placeholder={placeholder} value={draft} aria-invalid={invalid}
      aria-describedby={invalid ? hintId : undefined}
      onChange={e => {
        setDraft(e.currentTarget.value);
        setInvalid(false);
        const parsed = parse(e.currentTarget);
        if (parsed) onChange(parsed.data);
      }}
      onBlur={e => setInvalid(!parse(e.currentTarget))}
      onKeyDown={e => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === "Escape") {
          e.preventDefault();
          setDraft(String(value ?? ""));
          setInvalid(false);
        }
      }}
    />
    {invalid && <span id={hintId} className="filter-input-error" role="status">
      {min}–{max} 범위로 입력하세요. 이 값은 아직 적용되지 않았습니다.
    </span>}
  </span>;
}
export function Filters({
  value,
  onChange,
}: {
  value: FilterValues;
  onChange: (value: FilterValues) => void;
}) {
  const [resetVersion, setResetVersion] = useState(0);
  const set = (key: keyof FilterValues, v: unknown) =>
    onChange({ ...value, [key]: v });
  return (
    <div className="filter-panel">
      <div className="filter-row">
        <label className="check">
          <input
            type="checkbox"
            checked={value.relevance}
            onChange={(e) => set("relevance", e.target.checked)}
          />
          초기 관심으로 좁히기
        </label>
        <select
          aria-label="주제 관련성"
          value={value.strictness}
          onChange={(e) => set("strictness", e.target.value)}
        >
          <option value="strict">엄격</option>
          <option value="balanced">균형</option>
          <option value="broad">넓게</option>
        </select>
        <label>
          최소 피인용수{" "}
          <NumericFilter key={`citations-${resetVersion}`} field="minCitations"
            label="최소 피인용수" min={0} max={1e9} step="any"
            value={value.minCitations} onChange={v => set("minCitations", v)} />
        </label>
        <label>
          출판 기간{" "}
          <NumericFilter key={`from-${resetVersion}`} field="yearFrom"
            label="출판 시작 연도" min={1000} max={2200} placeholder="시작"
            value={value.yearFrom} onChange={v => set("yearFrom", v)} />
          <span>–</span>
          <NumericFilter key={`to-${resetVersion}`} field="yearTo"
            label="출판 끝 연도" min={1000} max={2200} placeholder="끝"
            value={value.yearTo} onChange={v => set("yearTo", v)} />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.unknownYear}
            onChange={(e) => set("unknownYear", e.target.checked)}
          />
          연도 미상 포함
        </label>
      </div>
      <div className="filter-row">
        <input
          className="word-filter"
          placeholder="포함어 (쉼표로 구분)"
          value={value.include}
          onChange={(e) => set("include", e.target.value)}
        />
        <input
          className="word-filter"
          placeholder="제외어 (쉼표로 구분)"
          value={value.exclude}
          onChange={(e) => set("exclude", e.target.value)}
        />
        <label>
          공통 연결{" "}
          <NumericFilter key={`shared-${resetVersion}`} field="minShared"
            label="공통 연결" min={1} max={10000}
            value={value.minShared} onChange={v => set("minShared", v)} />
        </label>
        <select
          aria-label="문헌 유형"
          value={value.types[0] || ""}
          onChange={(e) => set("types", e.target.value ? [e.target.value] : [])}
        >
          <option value="">모든 유형</option>
          {[
            "article",
            "review",
            "preprint",
            "book",
            "book-chapter",
            "proceedings-article",
            "dissertation",
          ].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="filter-row">
        {(
          [
            ["hasAbstract", "초록 있음"],
            ["hasPdf", "보관 PDF"],
            ["openAccess", "OA 링크"],
            ["hideSaved", "저장 문헌 숨김"],
            ["hideExcluded", "제외 문헌 숨김"],
            ["hideRetracted", "철회 후보 숨김"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="check">
            <input
              type="checkbox"
              checked={value[key]}
              onChange={(e) => set(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
        <button
          className="text-button"
          onClick={() => {
            setResetVersion(v => v + 1);
            onChange({ ...DEFAULT_FILTERS });
          }}
        >
          필터 초기화
        </button>
      </div>
      <p className="subtle">
        관련성은 이 후보 집합에서 계산한 텍스트·주제 기준입니다. 초록이 부족한
        논문은 판단 보류로 남습니다.
      </p>
    </div>
  );
}
