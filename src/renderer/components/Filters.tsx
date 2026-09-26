import type { Filters as FilterValues } from "../../shared/types";
import { DEFAULT_FILTERS } from "../../shared/types";
export function Filters({
  value,
  onChange,
}: {
  value: FilterValues;
  onChange: (value: FilterValues) => void;
}) {
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
          <input
            aria-label="최소 피인용수"
            type="number"
            min="0"
            value={value.minCitations}
            onChange={(e) =>
              set("minCitations", Math.max(0, Number(e.target.value)))
            }
          />
        </label>
        <label>
          출판 기간{" "}
          <input
            type="number"
            min="1000"
            max="2200"
            placeholder="시작"
            value={value.yearFrom ?? ""}
            onChange={(e) =>
              set("yearFrom", e.target.value ? Number(e.target.value) : null)
            }
          />
          <span>–</span>
          <input
            type="number"
            min="1000"
            max="2200"
            placeholder="끝"
            value={value.yearTo ?? ""}
            onChange={(e) =>
              set("yearTo", e.target.value ? Number(e.target.value) : null)
            }
          />
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
          <input
            type="number"
            min="1"
            value={value.minShared}
            onChange={(e) =>
              set("minShared", Math.max(1, Number(e.target.value)))
            }
          />
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
          onClick={() => onChange({ ...DEFAULT_FILTERS })}
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
