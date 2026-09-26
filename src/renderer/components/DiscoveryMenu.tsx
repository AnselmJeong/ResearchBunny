import { useId, useRef } from "react";
import { ChevronDown, FileText, Link, Network } from "lucide-react";
import type { DiscoveryMode } from "../../shared/types";

export function DiscoveryMenu({
  disabled,
  canDiscover,
  onDiscover,
  basis,
  onBasis,
}: {
  disabled: boolean;
  canDiscover: boolean;
  onDiscover: (mode: DiscoveryMode) => void;
  basis: "selected" | "archive";
  onBasis: (basis: "selected" | "archive") => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="discovery-menu">
      <button
        ref={trigger}
        className="primary"
        popoverTarget={id}
        disabled={disabled}
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          if (rect && menu.current) {
            menu.current.style.left = `${rect.left}px`;
            menu.current.style.top = `${rect.bottom + 6}px`;
          }
        }}
      >
        관련 문헌 찾기 <ChevronDown size={14} />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        className="discovery-popover"
        aria-label="문헌 탐색 작업"
      >
        {(
          [
            ["related", "관련 논문", Network],
            ["references", "참고문헌", FileText],
            ["citedBy", "후속 인용", Link],
          ] as const
        ).map(([mode, label, Icon]) => (
          <button
            key={mode}
            disabled={!canDiscover}
            onClick={() => {
              menu.current?.hidePopover();
              onDiscover(mode);
            }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
        <details className="common-discovery">
          <summary>공통 관계</summary>
          <label className="field">
            집계 기준
            <select
              value={basis}
              onChange={(e) => onBasis(e.target.value as typeof basis)}
            >
              <option value="selected">선택 문헌 / 초기 seed</option>
              <option value="archive">프로젝트 아카이브</option>
            </select>
          </label>
          {(
            [
              ["commonReferences", "공통 참고문헌"],
              ["commonCiting", "여러 편을 인용한 후속 연구"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              disabled={basis === "selected" && !canDiscover}
              onClick={() => {
                menu.current?.hidePopover();
                onDiscover(mode);
              }}
            >
              {label}
            </button>
          ))}
        </details>
      </div>
    </div>
  );
}
