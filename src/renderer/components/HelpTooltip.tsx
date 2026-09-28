import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const HELP: Record<string, string> = {
  프로젝트: "연구 주제별로 아카이브, 초기 관심 문헌과 탐색 경로를 나눕니다.",
  "새 프로젝트": "별도의 연구 주제와 아카이브를 만듭니다.",
  "문헌 탐색":
    "가장 최근 탐색 결과를 다시 엽니다. 이전 선택과 필터도 복원합니다.",
  "새 컬렉션":
    "프로젝트 안에서 논문을 주제별로 묶습니다. 같은 논문을 여러 컬렉션에 넣을 수 있습니다.",
  "탐색 이력":
    "이전 검색과 인용 확장의 결과, 출발 문헌, 조건을 확인하고 다시 엽니다.",
  "문헌 가져오기": "BibTeX 또는 PDF 파일을 가져옵니다. 원본 파일은 유지합니다.",
  설정로컬: "API 키, AI 사용 여부, 화면 테마와 백업·복원을 관리합니다.",
  "직전 라이브러리 변경 되돌리기":
    "직전 저장·제외·읽기 상태 변경을 취소합니다. 화면 이동은 왼쪽 뒤로 버튼을 사용하세요.",
  내보내기:
    "선택·컬렉션·프로젝트·전체 범위를 확인한 뒤 BibTeX 파일을 저장합니다.",
  "상세 패널 전환":
    "논문의 초록·발견 근거·노트·첨부를 보는 오른쪽 패널을 열거나 닫습니다.",
  "논문 검색":
    "OpenAlex에서 키워드·제목·DOI·OpenAlex ID로 논문을 찾습니다. ⌘K로 이동합니다.",
  검색: "새 검색 결과를 엽니다. 기존 탐색은 이력에 남습니다.",
  "검색 정렬": "새로 검색할 결과를 관련성·피인용수·발행일 순으로 요청합니다.",
  "의미 검색":
    "질문의 의미가 비슷한 논문을 찾습니다. 일반 키워드 검색과 API 한도가 다를 수 있습니다.",
  "API 키 설정": "OpenAlex 인증 키와 연결 상태를 설정합니다.",
  "핵심 논문 찾기실험":
    "AI가 연구 질문을 검색식으로 바꾸고 실제 후보를 추천합니다. 설정에서 AI 연결과 추천 사용을 설정하세요.",
  "기준 변경":
    "주제 관련성을 판단하는 초기 관심 문헌을 바꿉니다. 단순 화면 선택과는 별개입니다.",
  "seed 지정": "선택한 논문을 이후 탐색의 고정된 관심 기준으로 설정합니다.",
  seed: "선택 문헌을 초기 관심 기준으로 지정합니다. 아카이브 저장과는 별개입니다.",
  "목록 보기": "서지정보를 행 단위로 비교하고 여러 논문을 선택합니다.",
  "그래프 보기":
    "화면에 불러온 논문 사이의 인용 관계를 봅니다. 화살표는 인용하는 논문에서 인용된 논문으로 향합니다.",
  "연도 보기":
    "논문을 발행연도별로 배치합니다. 연도를 모르는 논문은 따로 표시합니다.",
  "관련 논문":
    "선택 문헌의 주제·인용 이웃에서 후보를 찾고 초기 관심 기준으로 관련성을 판단합니다.",
  참고문헌: "선택한 논문이 인용한 과거 연구를 찾습니다.",
  "후속 인용": "선택한 논문을 인용한 후속 연구를 찾습니다.",
  "공통 관계":
    "여러 논문이 함께 참고한 기반 연구나 여러 논문을 함께 인용한 후속 연구를 찾습니다.",
  "공통 참고문헌":
    "출발 문헌 중 여러 편이 함께 인용한 논문을 집계합니다. 최소 2편이 필요합니다.",
  "여러 편을 인용한 후속 연구":
    "출발 문헌 중 여러 편을 함께 인용한 논문을 찾습니다. 최소 2편이 필요합니다.",
  "현재 문헌에서 찾기":
    "지금 열린 결과 안에서 찾습니다. 새 OpenAlex 검색을 실행하지 않습니다.",
  필터: "관련성·연도·피인용수 등의 표시 조건을 조절합니다. 숨긴 논문은 삭제되지 않습니다.",
  "목록 정렬":
    "현재 결과의 표시 순서를 바꿉니다. 새로운 논문을 조회하지 않습니다.",
  "문헌 직접 등록": "검색 결과나 파일 없이 서지정보를 직접 입력합니다.",
  저장: "선택한 문헌을 이 프로젝트의 아카이브에 포함합니다. PDF를 자동 다운로드하지 않습니다.",
  "아카이브에 저장":
    "이 논문을 프로젝트 아카이브에 포함합니다. PDF는 별도로 가져올 수 있습니다.",
  "일괄 작업": "선택한 문헌의 컬렉션·태그·읽기 상태·제외 상태를 함께 바꿉니다.",
  "선택 해제": "화면의 선택만 해제합니다. 저장한 문헌은 남습니다.",
  "숨긴 결과와 이유 보기":
    "필터에 가려진 문헌을 다시 표시하고 제외된 이유를 확인합니다.",
  "50편 더 표시":
    "이미 확보한 결과를 50편 더 불러옵니다. 외부 API 호출은 추가하지 않습니다.",
  "API 추가 조회":
    "현재 탐색의 다음 페이지를 요청합니다. 추가 API 사용량이 발생할 수 있습니다.",
  취소: "진행 중인 작업을 멈춥니다. 이미 저장된 후보와 자료는 유지합니다.",
  재개: "중단한 위치에서 이어서 진행합니다. 외부 API 요청이 다시 발생할 수 있습니다.",
  확대: "그래프를 확대해 논문과 연결을 자세히 봅니다.",
  축소: "그래프를 축소해 더 넓은 관계를 봅니다.",
  "전체 맞춤": "표시된 논문이 화면 안에 들어오도록 그래프 크기를 맞춥니다.",
  "선택 주변": "상세 패널에서 보고 있는 논문과 직접 연결된 이웃을 강조합니다.",
  라벨: "그래프에서 저자·연도 표시를 켜거나 끕니다.",
  "유사 관계":
    "OpenAlex 관련 관계를 점선으로 표시합니다. 실제 인용선과는 다릅니다.",
  "500편까지":
    "그래프의 표시 한도를 300편에서 500편으로 늘립니다. 현재 불러온 결과 안에서만 표시합니다.",
  "문헌 노트":
    "이 프로젝트의 개인 메모입니다. 입력 후 자동 저장하며 AI 추천에 보내지 않습니다.",
  "파일 저장": "미리 확인한 범위의 문헌을 BibTeX 파일로 내보냅니다.",
  "기록 보기":
    "이전 탐색의 결과와 출발 문헌을 확인하고 원하는 단계를 다시 엽니다.",
  "무료 키 발급": "OpenAlex 계정의 API 키 발급 페이지를 브라우저로 엽니다.",
  "키 삭제 예약": "설정을 저장하면 이 공급자의 API 키를 기기에서 제거합니다.",
  "Finder에서 열기": "현재 사용 중인 로컬 라이브러리 폴더를 엽니다.",
  "관리 PDF 포함": "앱이 보관하는 PDF 사본도 백업에 포함합니다.",
  "외부 연결 PDF도 포함":
    "기존 위치에 연결한 PDF도 백업에 복사합니다. 원본은 유지합니다.",
  테마: "밝게·어둡게 또는 macOS의 화면 설정을 따르도록 선택합니다.",
  "연결 확인": "설정한 API 키로 공급자에 연결할 수 있는지 확인합니다.",
};
const normalize = (s: string) => s.replace(/\s+/g, "").trim();
const descriptions = new Map(
  Object.entries(HELP).map(([k, v]) => [normalize(k), v]),
);

export function HelpTooltip() {
  const [tip, setTip] = useState<{ target: HTMLElement; text: string } | null>(
    null,
  );
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const anchor = useRef<HTMLElement | null>(null);
  const clear = () => clearTimeout(timer.current);
  useEffect(() => {
    const hide = () => {
      clear();
      anchor.current = null;
      setTip(null);
    };
    const show = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        box.current?.contains(event.target)
      )
        return;
      const target = event.target.closest<HTMLElement>(
        "[data-help],button,summary,select,input,textarea,label",
      );
      const text =
        target?.dataset.help ||
        descriptions.get(
          normalize(
            target?.getAttribute("aria-label") ||
              target?.getAttribute("title") ||
              (target instanceof HTMLInputElement
                ? target.labels?.[0]?.textContent
                : target?.textContent) ||
              "",
          ),
        );
      if (!target || !text) {
        hide();
        return;
      }
      if (anchor.current === target) return;
      hide();
      anchor.current = target;
      timer.current = setTimeout(
        () => {
          if (
            target.isConnected &&
            (target.matches(":hover") ||
              target.contains(document.activeElement))
          )
            setTip({ target, text });
        },
        event.type === "focusin" ? 0 : 400,
      );
    };
    const leave = (event: Event) => {
      const next = (event as FocusEvent).relatedTarget;
      if (
        next instanceof Node &&
        (anchor.current?.contains(next) || box.current?.contains(next))
      )
        return;
      clear();
      timer.current = setTimeout(hide, 140);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    const onScroll = () => {
      const target = anchor.current;
      if (
        !target ||
        !(target.matches(":hover") || target.contains(document.activeElement))
      )
        hide();
      else if (box.current)
        setTip((current) => (current ? { ...current } : null));
    };
    document.addEventListener("pointerover", show);
    document.addEventListener("focusin", show);
    document.addEventListener("pointerout", leave);
    document.addEventListener("focusout", leave);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      clear();
      document.removeEventListener("pointerover", show);
      document.removeEventListener("focusin", show);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, []);
  useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const target = tip.target;
    const oldDescription = target.getAttribute("aria-describedby");
    const oldTitle = target.getAttribute("title");
    const oldLabel = target.getAttribute("aria-label");
    target.setAttribute(
      "aria-describedby",
      [oldDescription, "bunny-help"].filter(Boolean).join(" "),
    );
    if (oldTitle) {
      if (!oldLabel) target.setAttribute("aria-label", oldTitle);
      target.removeAttribute("title");
    }
    if (!box.current.matches(":popover-open")) box.current.showPopover();
    const rect = target.getBoundingClientRect(),
      size = box.current.getBoundingClientRect();
    box.current.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - size.width - 8))}px`;
    box.current.style.top = `${Math.max(8, rect.bottom + size.height + 12 < innerHeight ? rect.bottom + 8 : rect.top - size.height - 8)}px`;
    return () => {
      if (oldDescription)
        target.setAttribute("aria-describedby", oldDescription);
      else target.removeAttribute("aria-describedby");
      if (oldTitle) {
        target.setAttribute("title", oldTitle);
        if (!oldLabel) target.removeAttribute("aria-label");
      }
    };
  }, [tip]);
  return tip
    ? createPortal(
        <div
          id="bunny-help"
          ref={box}
          role="tooltip"
          popover="manual"
          className="help-tooltip"
          onPointerEnter={clear}
          onPointerLeave={() => {
            clear();
            anchor.current = null;
            setTip(null);
          }}
        >
          {tip.text}
        </div>,
        tip.target.closest("dialog[open]") || document.body,
      )
    : null;
}
