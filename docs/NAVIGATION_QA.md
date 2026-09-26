# ResearchBunny 0.1.1 — 탐색 복귀와 도움말 검증

2026-09-26, macOS arm64. 기존 사용자 라이브러리가 아닌 임시 SQLite 라이브러리에서 검사했다.

## 변경

- 상단 뒤로/앞으로와 부모 단계 경로를 제공한다. 단계별 최신 선택, 필터, 검색어, 정렬, 목록/그래프/연도 보기, 그래프 위치, 페이지와 상세 패널 상태를 보관한다.
- 관련 논문에서 원래 검색 단계로 돌아가 같은 선택 문헌으로 후속 인용을 탐색할 수 있다. 기존 분기는 최근 탐색/탐색 이력에 남고, 다시 열면 그 단계의 선택을 복원한다.
- 프로젝트별 이동 이력을 저장하고 재시작 시 복원한다. 새 검색은 독립된 경로로 시작한다. 다른 프로젝트의 탐색을 부모로 연결하는 요청은 거부한다.
- 주요 메뉴와 조작부에 hover/focus 설명을 제공한다. 비활성 버튼도 설명을 표시하며, Esc로 닫고 aria-describedby로 연결한다. 설정 대화상자 안에서도 설명을 표시한다.
- 기존 단일 화면 UI 환경설정을 읽을 수 있다. UI 상태의 개수·용량 제한은 DESIGN.md에 명시했으며 탐색 결과나 문헌을 삭제하지 않는다.

## 재현 가능한 검사

- `npm run typecheck`, `npm run lint`, `git diff --check`
- `npm test`: 18개 통합 검사. 상태 복원·분기·환경설정 크기 제한·프로젝트 경계 검사를 추가했다.
- `npm run test:navigation`: 검색 10편 중 3편 선택 → 관련 문헌 → 뒤로/앞으로 → 부모 단계 직접 이동 → 같은 3편의 후속 인용. 이전 분기 다시 열기, 정렬/결과 내 검색 복원, 재시작, 프로젝트 전환, 연도 보기, 도움말 hover/focus/Esc/설정 대화상자를 검사한다.
- `npm run test:desktop`: 기존 13개 데스크톱 검사. 문헌 등록, BibTeX, 선택, seed, 그래프, 내보내기, 재시작, PDF 중복과 원본 해시, 백업/복원, 서비스 복구, 파일 접근 경계를 포함한다.
- `node tests/desktop/usability.mjs`: 단축키, 긴 제목, 미확인 저자·연도, 1100×760 창, 다크 모드/그래프 등 5개 검사.

탐색 회귀 검사는 결정적인 OpenAlex 응답으로 실제 provider 캐시를 준비하고, 변경하지 않은 renderer → preload/IPC → discovery service → SQLite 경로를 실행한다. API를 흉내 낸 renderer 응답은 사용하지 않는다. 이번 검사는 탐색 UI 회귀 검사이며 OpenAlex 데이터 품질을 새로 평가한 결과가 아니다.

검사 JSON과 밝은/어두운 화면은 `artifacts/qa/navigation-report.json`, `navigation-light.png`, `navigation-dark.png`에 저장된다. 이 폴더는 Git 및 앱 배포에서 제외한다.

## 배포 확인

- 실제 `out/ResearchBunny-darwin-arm64/ResearchBunny.app`에서 탐색·도움말 6개 검사와 기존 데스크톱 13개 검사를 통과했다. 실행 PATH를 `/usr/bin:/bin:/usr/sbin:/sbin`으로 제한했고 renderer 예외는 없었다.
- `codesign --verify --deep --strict` 및 DMG `hdiutil verify` 통과. 로컬 ad-hoc 서명이며 Developer ID 서명·공증은 아니다.
- 번들 버전 0.1.1, 테스트 fixture/통합 테스트 bundle이 배포 asar에 포함되지 않음을 확인했다.
- DMG: `out/make/ResearchBunny-0.1.1-arm64.dmg`
- SHA-256: `7e022b59e66047ca4e373719cba663fe9178729f0bcfa2d4197e069faccc09a7`
