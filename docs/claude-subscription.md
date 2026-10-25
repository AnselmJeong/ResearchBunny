# Claude 구독 연결 · 2026-10-25

AI 연결 방식에 `Claude (Claude subscription)`을 더했다. 추천·분류·seed 검색어·수신함 정리·AI 대화가 모두 같은 연결을 쓰고, 계보 리포트([계획](genealogy-report-plan.md))의 단계별 모델로도 고를 수 있다. ScholarPen의 Claude 구독 연결(`src/bun/claude/`)을 옮겨 온 것이다.

## 연결과 과금 경계

- 사용자가 설치한 공식 Claude Code CLI를 수정 없이 실행한다. 2.1.273 이상을 요구하고 2.1.296에서 확인했다. `~/.local/bin`, Homebrew, `/usr/local/bin`, `~/.bun/bin`, `PATH` 순으로 찾는다.
- 로그인은 CLI의 `auth login --claudeai`, 상태는 `auth status --json`, 로그아웃은 `auth logout`이 맡는다. `CLAUDE_CONFIG_DIR`을 `~/Library/Application Support/ResearchBunny/claude`(또는 `RESEARCHBUNNY_DATA_DIR/claude`)로 두어 사용자의 평소 Claude Code 로그인과 분리한다. 이 폴더는 라이브러리 밖이라 백업에 들어가지 않는다. 앱은 OAuth 토큰을 읽거나 복사하지 않는다.
- 생성 전마다 `loggedIn`, `authMethod: claude.ai`, `apiProvider: firstParty`, 구독 종류를 확인한다. API 키 인증이나 Bedrock 같은 다른 공급자 로그인은 거절한다.
- 환경 변수는 허용 목록만 넘긴다. API 키, OAuth 토큰, 다른 엔드포인트, 모델 덮어쓰기는 넘기지 않는다.
- 사용자·프로젝트 설정을 읽지 않고(`--setting-sources ""`, 훅·메모리 끔), `--safe-mode`, `--tools ""`, 빈 MCP 설정과 `--strict-mcp-config`, 슬래시 명령·Chrome·세션 저장 끔, `--max-turns 1`로 실행한다. 지시문은 권한 600의 임시 파일, 입력은 stdin으로 보내고 끝나면 지운다.
- 한도 거절, 초과 사용(overage), 429 재시도, 한도 관련 오류 결과에서 즉시 중단한다. 알려진 초기화 시각 전에는 다음 요청을 시작하지 않는다. 모델을 바꾸거나 유료 API로 넘어가지 않는다. 계정 차원의 추가 사용 설정은 앱이 막을 수 없으므로 설정 화면에 그렇게 적었다.
- 모델은 CLI 별칭(`opus`, `sonnet`, `haiku`)과 "계정 기본 모델"에서 고른다. 접근 권한은 CLI가 판단한다.
- 구조화 출력은 Ollama Cloud와 같은 방식이다. 스키마를 지시문에 넣고, 답에서 JSON만 떼어(코드 울타리·앞뒤 문장 제거) 기존 검증기가 판정한다. CLI의 `--json-schema`는 도구 호출로 구현되어 `--tools ""`·`--max-turns 1`과 함께 쓸 수 있는지 확인하지 못해 쓰지 않았다.

## 계보 리포트용 공통 호출 계층

`src/service/genealogy/llm.ts`의 `GenealogyAI`가 계보 작업의 모든 AI 호출을 맡는다.

- 단계(`light`·`cards`·`write`)마다 공급자와 모델을 따로 고른다. 기본값은 설정에서 고른 연결이고, 설정이 OpenAI API면 Codex로 둔다. 계보 작업은 유료 API를 쓰지 않는다.
- 답이 JSON이 아니거나 검증에 걸리면 이유를 붙여 한 번 다시 요청한다. 두 번 실패하면 `AI_FORMAT`.
- 구독 한도 오류는 `BUDGET`으로 바꿔 작업이 실패가 아니라 일시정지되게 한다.
- `Meter`가 작업당 호출 수와 호출당 입력량을 제한한다. 추천·분류의 실행당 3회 제한과는 별개다.

## 검증

- 가짜 CLI(`tests/fixtures/claude/cli.ts`)로 23개 시험: UTF-8 스트리밍, 도구·MCP·훅·세션 저장 끔, 모델 플래그, 구조화 출력, 로그인 상태별 차단, 한도·초과 사용·429·오류 결과에서 재시도 없이 중단, 형식 오류·비정상 종료·잘림, 취소·시간 초과와 임시 파일 정리, 로그인·취소·로그아웃, 환경 변수 차단, 대화·추천 경로가 다른 공급자나 HTTP로 새지 않음, 설정 저장.
- 계보 호출 계층 6개 시험: 단계별 경로, 수정 재요청, 두 번 실패, 한도 → 일시정지, 호출·입력 상한, 기본 경로.
- 실제 Claude Code 2.1.296: 빈 전용 설정 폴더에서 버전 확인과 `signedOut` 판정, 생성 플래그 전체를 받아들이고 `tools: []`, `mcp_servers: []`로 시작함을 확인했다.
- 실제 계정 응답은 확인하지 못했다. 앱 전용 설정 폴더에 브라우저 로그인을 해야 하므로, 설정 → AI 연결 → Claude에서 `Claude 계정으로 로그인`을 누른 뒤 확인이 필요하다.
