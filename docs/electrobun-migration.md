# Electrobun / WebKit 전환 — 0.2.0

2026-09-27, macOS Apple Silicon에서 구현·검증했습니다.

## 범위와 구현

React UI와 문헌 탐색·아카이브·SQLite 스키마·백업 형식을 유지하면서 Electron을 Electrobun 1.18.1 / Bun 1.3.8 / macOS WKWebView로 교체했습니다. CEF와 WGPU는 번들에 포함하지 않습니다. Electrobun 2.x의 도구 체계 변경을 이번 앱 전환과 함께 진행하지 않도록 버전을 고정했습니다.

사용자 결정에 따라 파일/폴더 드롭을 제거했습니다. macOS 선택 창에서 여러 PDF 또는 여러 폴더를 선택합니다. 폴더는 하위 폴더까지 검색합니다. Swift NSOpenPanel/NSSavePanel과 JSON 경로 전달을 사용해 쉼표·한글이 들어간 경로를 처리합니다.

- Electron preload/IPC → 타입이 지정된 Electrobun RPC. WKWebView에서 소켓 연결 후 응답이 사라지는 현상을 재현하여 네이티브 브리지로 고정했습니다. Renderer의 네트워크 CSP 제한은 유지합니다.
- Electron utility process → 별도 Bun 서비스 프로세스. 준비 완료, 시간 제한, 종료, 충돌 후 재시작과 키 재전달을 처리합니다.
- better-sqlite3 → bun:sqlite 어댑터. 백업은 `VACUUM INTO`로 일관된 스냅샷을 만듭니다.
- PDF 처리는 별도 Bun 자식 프로세스로 실행합니다. Bun worker thread의 native canvas 종료 충돌을 회피하며 15초 제한과 취소를 처리합니다. 기존 V8 worker의 384MB heap 제한은 Bun 프로세스에 적용되지 않습니다. 100MB 초과 PDF는 추출을 생략합니다.
- PDF.js 런타임·폰트·CMap·현재 아키텍처의 canvas 바이너리만 포함합니다. Node/Python 또는 사용자 PATH는 실행에 필요하지 않습니다.
- 단일 실행은 `flock`과 로컬 소켓으로 처리합니다. 실행 중인 기존 Electron 인스턴스도 확인합니다.

## 기존 데이터

`~/Library/Application Support/ResearchBunny`와 `library-location.json`의 사용자 지정 라이브러리 위치를 유지합니다. 지정한 라이브러리가 없으면 빈 라이브러리로 대체하지 않고 오류를 표시합니다. 원본 PDF와 기존 암호화 `credentials.json`을 변환·삭제하지 않습니다.

새 API 키는 macOS 키체인에 저장합니다. Electron 암호화 키는 설정 화면에서 한 번 다시 입력해야 합니다. 키체인 접근 실패 시 평문 저장으로 대체하지 않습니다. 키는 renderer, 데이터베이스, 백업에 포함하지 않습니다.

## 검증 결과

- `bun run typecheck`, `bun run lint`: 통과.
- `bun run test`: 22개 통과, 0개 실패. PDF 100개 실제 추출 및 원본 해시 보존, BibTeX 120개 왕복, 백업·복원, 탐색 상태, 서비스 충돌 복구, 프로세스 잠금과 충돌 후 잠금 회수, 임시 키체인 항목의 저장·갱신·읽기를 확인했습니다. 키체인 시험 항목은 삭제했습니다.
- `bun run test:desktop`: 배포 앱 내부 Bun으로 제한된 `PATH=/usr/bin:/bin`에서 PDF 실제 추출, 아카이브, BibTeX 출력, 백업·복원을 확인했습니다.
- 실제 WKWebView UI: 쉼표/한글 이름의 PDF 두 개 동시 선택·가져오기, 두 항목 저장과 네이티브 저장 창을 통한 BibTeX 2개 출력, 폴더 가져오기와 컬렉션 생성, 선택 창 취소, Cytoscape 그래프를 확인했습니다.
- 최종 stable 앱: `interoception social cognition` 실제 OpenAlex 검색에서 결과 50편과 추가 조회 가능한 전체 결과 수가 표시됐습니다.
- `codesign --verify --deep --strict`로 압축 해제된 stable 앱의 서명을 확인했습니다. 서명은 로컬 ad-hoc이며 Developer ID 서명이나 Apple 공증은 아닙니다.
- `hdiutil verify`로 생성한 DMG 무결성을 확인했습니다.

자동 시험과 UI 가져오기/검색은 분리된 임시 라이브러리에서 실행했습니다. 실제 OpenAI 유료 호출, 추천 의미 품질 평가, Intel/Windows/Linux 호환성은 이번 검증에 포함하지 않았습니다. 설치된 `/Applications` 앱을 교체하지 않았습니다.

## 용량과 결과물

`du -sk` 기준이며 앱 크기는 첫 실행 압축 해제 후 비교했습니다.

| 결과물 | 크기 |
| --- | ---: |
| 기존 Electron 0.1.2 앱 | 약 444 MiB |
| WebKit 0.2.0 앱 | 105,652 KiB ≈ 103.2 MiB |
| WebKit 0.2.0 DMG | 29,948 KiB ≈ 29.2 MiB |

설치 앱 용량이 약 77% 줄었습니다. Bun 런타임과 PDF 추출용 native canvas가 남은 용량의 주요 구성 요소입니다.

- 앱: `build/stable-macos-arm64/ResearchBunny.app`
- 배포: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg`

## 재현

```sh
npm ci
bun run typecheck
bun run lint
bun run test
bun run package
# stable 앱을 첫 실행해 압축을 해제한 후:
bun run test:desktop
```

`package`는 Xcode Command Line Tools와 네트워크가 필요하며, npm에 고정한 Electrobun CLI가 아직 없으면 공식 배포 바이너리를 준비합니다. 첫 실행용 압축 앱과 DMG를 생성합니다. `test:desktop`은 압축 해제된 앱에 실행합니다.

UI QA는 `RESEARCHBUNNY_BUILD_QA_ROOT="$PWD/.qa/ui" bun run build`로 전용 식별자의 QA 앱을 만든 뒤 실행할 수 있습니다. 일반 릴리스에는 이 변수를 지정하지 마세요. QA 자료를 `out/electrobun`에 두면 패키징 과정에서 정리되므로 `.qa`를 사용합니다.

기존 Electron용 CDP 자동화 스크립트는 WKWebView에 적용되지 않아 제거했습니다. UI 전체 회귀 자동화를 대체한 것으로 주장하지 않으며, 이번 전환은 서비스 통합 시험·패키지 실행 시험·실제 네이티브 UI 확인을 조합해 검증했습니다.
