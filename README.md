# ResearchBunny

관심 논문에서 출발해 참고문헌과 후속 연구를 탐색하고, 선별한 논문을 로컬 아카이브로 보관하는 macOS 앱입니다. [PRD](PRD.md)의 P0 흐름을 구현한 **0.1.2 로컬 시험판**입니다.

## 설치와 실행

0.1.2는 아래 개발 실행 명령으로 실행하거나 `npm run make`로 새 패키지를 만듭니다. 기존 DMG에는 이번 디자인 변경이 포함되지 않습니다.

- 기존 0.1.1 Apple Silicon용 DMG: `out/make/ResearchBunny-0.1.1-arm64.dmg`
- 앱: `out/ResearchBunny-darwin-arm64/ResearchBunny.app`
- DMG를 열어 ResearchBunny를 Applications로 복사한 뒤 실행합니다.
- 로컬 ad-hoc 서명입니다. Developer ID 서명·Apple 공증은 하지 않았습니다. 다른 Mac에서 내려받은 파일은 Gatekeeper의 승인이 필요할 수 있습니다.
- 번들의 최소 OS는 macOS 13입니다. 실제 검증 환경은 macOS 27.2, Apple M2 Max, 64GB입니다. macOS 13·16GB 기기 및 Intel은 미검증입니다.

## 첫 아카이브 만들기

1. 검색창에 키워드·제목·DOI·OpenAlex ID를 넣습니다. 기존 BibTeX 또는 PDF로 시작할 수도 있습니다.
2. 문헌 행을 눌러 초록과 출처를 확인합니다. 체크박스는 일괄 작업용 선택이며, 상세 패널 열기와 별개입니다.
3. 선택한 논문을 `seed`로 지정하고 연구 질문을 저장합니다. 이 초기 관심 기준은 다음 탐색에서 다른 논문을 선택해도 바뀌지 않습니다.
4. `관련 논문`, `참고문헌`, `후속 인용`, `공통 참고문헌`, `공통 후속 연구` 중 필요한 탐색을 실행합니다. 선택 집합 또는 아카이브를 출발점으로 사용합니다.
5. 필터에서 관련성·연도·최소 인용수 등을 조절합니다. 숨겨진 후보와 초록 부족으로 판단을 보류한 후보도 확인할 수 있습니다.
6. 목록·그래프·연도 보기에서 문헌을 선택해 저장하고, 컬렉션·별표·태그·읽기 상태·노트를 정리합니다.
7. 내보내기 창에서 선택·컬렉션·프로젝트·전체 범위와 편수를 확인하고 BibTeX를 저장합니다. 비공개 노트와 파일 경로는 기본 출력에서 제외합니다.

상단의 **뒤로/앞으로** 버튼은 당시 선택·필터·보기 상태를 복원합니다. 결과 위의 **탐색 경로**에서 원하는 부모 단계를 바로 누를 수도 있습니다. 예를 들어 3편을 선택해 관련 논문을 탐색한 뒤 검색 단계로 돌아오면, 같은 3편으로 후속 인용을 찾을 수 있습니다. 다른 방향으로 탐색해도 기존 결과는 최근 탐색과 탐색 이력에 남습니다. 새 키워드 검색은 독립된 경로로 시작합니다.

0.1.2에서는 **관련 문헌 찾기** 메뉴에 탐색 작업을 모았습니다. 상세 패널은 초록·발견 근거·노트 탭으로 나누고, 아카이브에 읽기 상태 필터를 추가했습니다. 탐색 이력과 설정은 전체 작업 화면에서 엽니다.

주요 메뉴와 버튼에 마우스를 잠시 올리거나 키보드로 초점을 옮기면 기능 설명이 표시됩니다. Esc로 닫을 수 있습니다.

단축키: `⌘K` 검색, 입력 중이 아닐 때 `⌘A` 현재 페이지 선택, `⌘S` 선택 저장, `⌘E` 내보내기. 목록 체크박스의 Shift 선택과 그래프의 Shift+드래그를 지원합니다.

실선 화살표는 **인용하는 논문 → 인용된 논문**입니다. `유사 관계`를 켰을 때의 점선은 OpenAlex가 제공한 관련 관계이며 인용 방향을 의미하지 않습니다. 그래프는 기본 300편, 선택 시 최대 500편과 인용선 3,000개를 표시합니다. 표시 범위 밖의 자료는 목록에서 접근합니다.

## API 설정

설정에서 OpenAlex 키와 연결 상태를 관리합니다. 현재 익명 검색도 동작하지만 공급자의 인증·사용 한도 정책에 따라 키가 필요할 수 있습니다. 키는 Authorization 헤더로 전달합니다.

GPT 추천은 별도의 OpenAI API 키와 `OpenAI 추천 사용` 설정이 필요한 **실험 기능**입니다. 사용자가 실행하면 연구 질문과 검색한 후보의 제목·초록·관계 메타데이터를 OpenAI에 보냅니다. PDF 전문과 개인 노트는 보내지 않습니다. API 사용에는 공급자 비용이 발생할 수 있으며 앱에서 모델·요금·호출·토큰·금액 상한을 설정합니다. 요금 입력값은 사용자가 확인하는 예상 비용 기준입니다.

키는 macOS `safeStorage`로 암호화한 별도 파일에 보관합니다. 키 저장 또는 기존 키 읽기 시 macOS 키체인 확인 창이 나타날 수 있습니다. 암호화가 불가능하면 평문 저장으로 전환하지 않습니다. 키가 없는 첫 실행은 키체인 접근 없이 로컬 기능을 엽니다.

실제 OpenAI 호출과 사람이 판정하는 추천 품질 평가는 아직 수행하지 않았습니다. 식별자·인용문 검증은 의미적 타당성이나 논문의 중요도를 보증하지 않습니다. AI를 설정하지 않아도 검색·탐색·아카이브·내보내기를 사용할 수 있습니다.

## 파일과 데이터 보존

기본 위치는 `~/Library/Application Support/ResearchBunny/`입니다. 설정 화면에 현재 라이브러리의 정확한 위치가 나옵니다.

| 경로                     | 내용                                    |
| ------------------------ | --------------------------------------- |
| `library/library.sqlite` | 문헌·프로젝트 상태·노트·관계·작업 기록  |
| `library/attachments/`   | SHA-256으로 식별한 관리 PDF 사본        |
| `credentials.json`       | OS 보호 암호화 키. 백업에 포함하지 않음 |
| `library-location.json`  | 복원 후 현재 라이브러리 위치            |
| `libraries/restored-…/`  | 기존 라이브러리와 분리해 검증한 복원본  |

PDF 기본값은 앱 관리 폴더로 복사입니다. 기존 위치 연결과 서지정보만 가져오기도 지원합니다. 원본 파일은 수정·이동·삭제하지 않습니다. 파일 해시가 같으면 중복 첨부를 만들지 않습니다. 메타데이터·첫 페이지 추출은 파일당 15초, worker 메모리 384MB로 제한하며 100MB 초과 파일은 텍스트 추출을 생략합니다. 스캔·암호화·부정확한 서지는 대기함에서 직접 수정하거나 기존 문헌에 연결하세요. OCR은 포함하지 않습니다.

가져오기 기록의 `파일별 결과 보기`에서 실패 이유를 확인하고 실패 파일을 재시도할 수 있습니다. 외부 연결 파일을 옮겼으면 상세 패널의 재연결을 사용합니다. 휴지통 이동은 복구 가능하며 자동 영구 삭제는 하지 않습니다.

설정의 백업은 SQLite 온라인 백업과 선택한 첨부를 **백업 폴더**로 만듭니다. 외부 연결 파일 포함 여부도 선택할 수 있습니다. manifest와 SHA-256 검증 후 별도 공간에 복원하고 현재 라이브러리를 전환합니다. 기존 라이브러리는 남습니다. 누락 첨부는 보고하고 재연결이 필요한 상태로 표시합니다. 실행 중인 `.sqlite` 파일만 임의로 복사하면 WAL 변경을 빠뜨릴 수 있으므로 앱 백업을 사용하세요.

## 작업 범위와 한도

- 탐색은 사용자가 요청한 한 단계씩 실행합니다. 일반 실행은 40회 호출·후보 1,000편, AI 수집은 후보 500편부터 시작합니다. 추가 조회·재개는 별도 사용자 동작입니다.
- 호출 상한과 페이지 중간 체크포인트를 보존합니다. 취소·오류·재시작 후 이미 저장한 후보는 유지합니다. 앱을 완전히 종료한 동안에는 작업하지 않습니다.
- OpenAlex의 누락과 잘못된 메타데이터가 존재할 수 있습니다. 공통 관계 수는 확보한 출발 문헌·이웃 안의 집계입니다. 분야 전체의 완전한 네트워크가 아닙니다.
- 관련성 점수와 엄격도는 `tfidf-topic-v1` 임시 기준선입니다. 서로 다른 실행의 점수를 절대 척도로 비교하지 않습니다.
- P1–P3의 동기화·알림·내장 PDF 독서·OCR·자동 문헌고찰·협업은 포함하지 않습니다.

## 개발과 검증

Node.js 22 이상과 macOS 개발 도구가 있는 환경에서:

```sh
npm ci
npm run start
npm run typecheck
npm run lint
npm test
npm run test:desktop
npm run test:navigation
npm run test:design
npm run test:live
npm run make
```

`npm ci`는 Electron ABI에 맞게 SQLite 네이티브 모듈을 준비합니다. `npm run make`는 `.app` 패키징·로컬 서명·DMG 생성·DMG 무결성 검증을 수행합니다. Node/Python을 설치하지 않은 사용자의 PATH에 의존하지 않습니다.

패키지 앱 검증과 성능 측정:

```sh
RESEARCHBUNNY_APP="$PWD/out/ResearchBunny-darwin-arm64/ResearchBunny.app/Contents/MacOS/ResearchBunny" node tests/desktop/smoke.mjs
RESEARCHBUNNY_APP="$PWD/out/ResearchBunny-darwin-arm64/ResearchBunny.app/Contents/MacOS/ResearchBunny" node tests/desktop/navigation.mjs
RESEARCHBUNNY_APP="$PWD/out/ResearchBunny-darwin-arm64/ResearchBunny.app/Contents/MacOS/ResearchBunny" node tests/desktop/live.mjs
node scripts/performance.mjs
```

실제 API 테스트는 공개 문헌 조회를 수행합니다. 자동 테스트는 임시 라이브러리를 사용합니다. `RESEARCHBUNNY_DATA_DIR` 환경 변수로 개발 데이터 위치를 분리할 수 있습니다. 정상 사용자의 자료에 테스트 fixture를 넣지 않습니다.

구조와 검증 근거는 [설계 결정](docs/DESIGN.md), [초기 검증 보고서](docs/verification-report.md), [0.1.1 탐색·도움말 검증](docs/NAVIGATION_QA.md), [0.1.2 디자인 검증](docs/DESIGN_CONCEPT_QA.md), [추천 평가 상태](docs/evaluation-report.md), [구현 계획](IMPLEMENTATION_PLAN.md)에 기록합니다.
