# ResearchBunny 0.1.0 검증 보고서

2026-09-26 · **macOS arm64 로컬 시험판**. PRD P0의 핵심 작업을 구현하고 실제 패키지에서 확인했다. 아래 미검증 항목과 GPT 품질 평가를 포함한 전체 공개 출시 기준의 완료를 주장하지 않는다.

## 산출물

| 항목        | 위치 또는 상태                                               |
| ----------- | ------------------------------------------------------------ |
| 앱          | `out/ResearchBunny-darwin-arm64/ResearchBunny.app`           |
| DMG         | `out/make/ResearchBunny-0.1.0-arm64.dmg`                     |
| DMG SHA-256 | 같은 경로의 `.dmg.sha256`                                    |
| 플랫폼      | macOS arm64, 번들 최소 macOS 13.0                            |
| 실제 기기   | Apple M2 Max / 64GB / macOS 27.2 (26B5091g)                  |
| 서명        | ad-hoc, `codesign --verify --deep --strict` 통과             |
| DMG         | hdiutil 생성·checksum 검증, 읽기 전용 마운트 후 앱 실행 검사 |
| 공증        | Developer ID 서명·notarization 미수행                        |

앱과 helper의 bundle identifier를 유지하며 내부 파일부터 서명한다. native SQLite 모듈, PDF.js worker와 표준 폰트, preload, renderer, 아이콘을 포함한다. 사용 기기의 Node/Python/PATH를 요구하지 않는다.

최종 DMG: **194,720,395 bytes**, SHA-256 `4efc49ec8a296974ac1df09139fe7073df2d1ebba085c5313e992671a914c354`.

## 검증 결과

| 검사          | 결과와 범위                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| TypeScript    | `npm run typecheck` 통과                                                                                  |
| ESLint        | `npm run lint` 통과                                                                                       |
| 통합 테스트   | `npm test`: 15개 통과, 실패 0개                                                                           |
| 패키지 자동화 | `tests/desktop/smoke.mjs`: 13개 검사 통과                                                                 |
| 실제 API      | `tests/desktop/live.mjs`: 패키지에서 DOI 검색 → 참고문헌 → 후속 인용 → 그래프/inspection 통과             |
| 기본 사용성   | 검색 포커스/전체 선택/저장/export 키보드 흐름, 긴 제목, 저자·연도 결측, 1100×760 창, 다크모드/그래프 확인 |
| 런타임 의존성 | `npm audit --omit=dev`: 보고된 취약점 0건                                                                 |
| 소스 범위     | Git whitespace 검사 통과. 커밋·push 상태는 Git 이력 참조                                                              |

데스크톱 자동화는 임시 라이브러리를 만들며 실제 UI·preload·main·utility process·SQLite·파일 작업을 사용한다. OS 파일 대화상자의 입력/출력 경로만 테스트 파일로 지정했다. API fixture를 실제 API 호출로 설명하지 않는다.

### 15개 통합 테스트의 주요 보장

1. DOI 정규화, sparse abstract 복원, 알려진 빈 참고문헌과 미제공 구분.
2. 외부 식별자 중복 방지, citekey 안정성, 사용자 수정 보존, 프로젝트별 상태 분리.
3. 120개 BibTeX 왕복: 매크로·기관 저자·유니코드·사용자 필드·부분 export·개인 필드 제외.
4. 손상된 BibTeX 일부 항목만 실패하고 정상 엔트리 및 crossref 상속 필드 유지.
5. 휴지통/상태 되돌리기 및 중복 병합 취소로 노트 복구.
6. 작은 인용 그래프의 방향·공통 참고/후속 집계·초기 seed 유지. 공급자 자기 참조는 원본에 보존하고 그래프 자기 고리는 제외. 유사 관계는 무방향 중복 제거.
7. 높은 인용수로 관련성 필터를 우회하지 않으며 초록 결측은 판단 보류.
8. 취소와 DB 재열기 이후 작업 체크포인트·기존 노트 보존.
9. 공급자 429/호출 예산 처리와 Authorization 헤더 인증.
10. AI의 가짜 ID·근거·인용문·추가 숫자·중복 추천 거부.
11. PDF worker 실제 추출, 같은 PDF 반복 import, 원본 SHA-256 보존.
12. SQLite 온라인 백업과 첨부 복원, 잘못된 manifest/hash/경로 거부.
13. IPC 스키마가 raw SQL·과도한 입력·잘못된 필드를 거부.
14. 후보 예산이 페이지 중간에 끝나도 미처리 결과를 체크포인트에 남기고 재개.
15. 서로 다른 합성 PDF 100개의 배치 import와 모든 원본 해시 보존.

### 실제 설치 산출물에서 확인한 경로

- 빈 화면, 수동 등록, 노트 자동 저장, BibTeX 미리보기/import, 일괄 저장, seed 고정, 그래프와 연도 보기.
- 선택 3편을 실제 `.bib` 파일로 내보내고 항목 수와 개인 노트 제외 확인.
- 앱 종료·재실행 후 노트와 seed 유지.
- 제한된 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`에서 패키지 PDF worker가 파일명과 다른 첫 페이지 제목을 추출함.
- 관리 PDF 첨부를 포함한 백업을 새 라이브러리에 복원하고 노트·seed·파일 해시 비교.
- 자료 utility process에 SIGKILL을 보내 자동 복구한 뒤 commit된 노트 보존 확인.
- renderer에 `require`, `process`, 임의 IPC가 없고 등록되지 않은 경로의 import 거부.
- DMG를 읽기 전용으로 마운트한 경로의 앱으로 동일 검사를 수행함.
- macOS 일반 앱 실행 경로로 최종 `.app`을 열어 네이티브 창과 실제 빈 라이브러리 화면의 접근성 트리를 확인했다. 테스트 자료를 기본 사용자 라이브러리에 넣지 않았다.
- 손상된 키 파일이 있어도 로컬 라이브러리 화면을 열고 대체 키를 입력할 수 있도록 원본 파일을 보존한다.

### 실제 OpenAlex 응답

공개 문헌으로 제한된 live 조회를 수행했다. 키 없이 성공한 현재 관측이며 인증 정책의 영구 보장이 아니다.

| 조회                                     | 관측                                                                |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `interoception social cognition`         | 일반 API 검색 결과 수신                                             |
| `10.1016/j.neuropsychologia.2017.01.001` | `W2569940591`, 제목 확인, 초록 미제공 처리                          |
| 참고문헌 확장                            | 후보 191편, 표시 집합과 출발 문헌 안의 인용선 1,634개               |
| 후속 인용 확장                           | 인용순/최근순의 첫 페이지를 합쳐 100편. 전역 405편 중 부분 범위     |
| 인용 방향                                | 각 edge의 source 원문 references에 target OpenAlex ID가 있는지 검사 |
| 초기 관심                                | 다른 확장 실행 후에도 원 seed ID가 동일함                           |

숫자는 조회 시점의 공급자 자료다. API의 `referenced_works` 193개와 반환 문헌 191편이 같다고 가정하지 않는다. 일부 ID의 병합·결측과 데이터 변경 가능성을 포함한다. 논문의 학술적 적합성을 사람이 평가한 결과가 아니다.

## 성능

| 시나리오                                              | 측정                                   |
| ----------------------------------------------------- | -------------------------------------- |
| DB 5,000문헌 / 30,000인용선, 첫 500편 반환            | 10회 조회 p95 **315.7ms**              |
| 실제 Electron 그래프 500노드 / 3,000선, 90프레임 이동 | 프레임 p95 **23.9ms**, 평균 **17.8ms** |
| 그래프 20노드 선택 후 다음 프레임                     | **55.8ms**, 단일 측정                  |

개발 빌드의 실제 React/Cytoscape 화면으로 측정했다. 샘플 수가 작으며 마지막 선택 수치는 p95가 아니다. PRD의 16GB 기준 기기·장시간 사용·최악 밀도 그래프는 미검증이다. 그래프 기본 상한은 300노드, 사용자가 500노드까지 켤 수 있다.

## 수정한 실제 문제

- 패키지의 utility process 작업 폴더가 ASAR 파일을 가리키던 문제를 실제 라이브러리 루트로 수정했다.
- 첫 실행에서 필요 없이 키체인을 열어 서명 변경 후 시작이 멈추던 경로를 수정했다. 저장된 키가 없는 경우 키체인을 열지 않는다.
- DOI 직접 조회를 OpenAlex의 DOI URL 경로로 수정했다.
- 후보 상한에서 페이지 일부가 유실되던 체크포인트와 후보 수 계산 비용을 수정했다.
- 로컬 scope 전환 시 오래된 행이 남는 문제, 다이얼로그 뒤의 토스트, export의 빈 컬렉션 ID, 다크모드의 기본 텍스트/배경을 수정했다.

## 보안·개인정보 범위

고정된 provider 호스트, sandbox/contextIsolation, Zod 입력, IPC 발신 프레임 검증, 등록된 drop capability, 외부 이동 차단, OS 대화상자로 선택한 경로만 쓰는 구조를 검사했다. 백업 경로 traversal/symlink와 해시 불일치를 거부한다. PDF 추출은 시간·worker heap 상한을 두며 OCR/스크립트를 실행하지 않는다.

번들에 테스트·소스 폴더·진단 결과·credentials 파일·환경 파일이 없고, 생성된 JS/source map에 사용자 기기의 절대 작업 경로가 없음을 검사했다. BibTeX 기본 export의 개인 노트/파일 경로 제외를 확인했다. 로컬 DB 전체 암호화나 정식 보안 감사를 수행한 것은 아니다.

개발 의존성에는 Forge가 사용하는 `extract-zip` 계열의 high 등급 advisory 15건이 남아 있다. 실제 포함되는 runtime 의존성 audit는 0건이다. 배포 도구를 무리하게 주요 버전 교체하지 않고 lockfile과 해당 제한을 기록했다.

## 남은 출시 검증

- 실제 API 키의 safeStorage 저장·재읽기와 서명 변경 시 사용자 키체인 응답.
- 실제 OpenAI 호출, 의미 검색 인증/한도, 모델별 예산/거부 응답과 사람이 평가한 5×50편 추천 품질. [평가 상태](evaluation-report.md) 참조.
- 잠자기/복귀, 물리적 디스크 부족·외장 볼륨 분리, 쓰기 중 앱 본체 강제 종료. 서비스 강제 종료와 합성 실패 검사를 전체 OS 장애 시험으로 확대 해석하지 않음.
- 다양한 실제 스캔·암호화·손상 PDF, 저자·연도까지 결합하는 불확실 서지 매칭.
- VoiceOver와 전체 접근성, macOS 13/16GB 기기, Intel, 다른 Mac의 Gatekeeper/공증.
- P1–P3 기능과 정식 자동 업데이트는 이번 범위 밖.

## 재현과 증거

[README](../README.md)의 명령으로 빌드와 테스트를 재현한다. 임시 테스트 라이브러리는 종료 시 정리하며 결과는 `artifacts/qa/`에 기록한다.

- `desktop-report.json`, `live-desktop.json`, `live-openalex.json`, `usability-report.json`
- `performance-db.json`, `performance-graph.json`, `package-report.json`, `audit-production.json`
- `live-library.png`, `live-citation-graph.png`, `graph-500.png`, `dark-compact.png`, `dark-graph.png`
