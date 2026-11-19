# ResearchBunny 커넥터

ScholarPen과 외부 에이전트(Claude Code, Codex)가 ResearchBunny 라이브러리를 읽는 MCP 서버다. `docs/paperlab-scholarpen-integration.md` 7절의 4단계 구현이다.

- **읽기 전용.** 라이브러리(`library.sqlite`)와 본문 구절 색인(`passages.sqlite`)을 읽기 전용으로 연다. 앱이 켜져 있어도, 꺼져 있어도 된다. 쓰는 것은 호출 기록 한 줄뿐이다(아래).
- **stdio, 줄 단위 JSON-RPC.** 포트도 토큰도 없다. 호출한 쪽이 자식 프로세스로 띄운다.
- **LLM을 부르지 않는다.** 검색하고 원문을 줄 뿐이다. 구절이 주장을 뒷받침하는지는 호출한 쪽(ScholarPen의 판정기)이 정한다.

## 실행

앱 번들 안의 실행 파일:

```
/Applications/ResearchBunny.app/Contents/Resources/app/runtime/researchbunny-connector
```

이 스크립트는 번들의 bun으로 `connector.js`를 실행한다. 패키징에서 실행 권한이 빠질 수 있으므로 `/bin/sh <경로>`로 부른다. 저장소에서는 `bun src/connector/index.ts`로 같은 것을 띄울 수 있다.

옵션:

| 옵션 | 뜻 |
|---|---|
| `--data <폴더>` | 라이브러리 폴더. 없으면 앱과 같은 곳(`~/Library/Application Support/ResearchBunny/library`, 복원으로 옮겼으면 그 위치) |
| `--project <id 또는 이름>` | 범위를 생략한 호출의 기본 프로젝트 |
| `--log <파일>` / `--no-log` | 호출 기록 위치. 기본은 `~/Library/Application Support/ResearchBunny/logs/connector-calls.jsonl` |

`--project`가 없으면 실행한 폴더의 `.researchbunny/project.json`(ScholarPen 폴더 연결, 6절)이 가리키는 프로젝트가 기본이 된다. 연결된 ScholarPen 폴더에서 에이전트를 실행하면 따로 정할 것이 없다.

에이전트 등록:

```
claude mcp add researchbunny -- /bin/sh '/Applications/ResearchBunny.app/Contents/Resources/app/runtime/researchbunny-connector'
codex mcp add researchbunny -- /bin/sh '/Applications/ResearchBunny.app/Contents/Resources/app/runtime/researchbunny-connector'
```

설정 → ScholarPen 연동에 이 명령이 실제 경로로 나온다.

## 도구

모든 도구는 읽기 전용(`readOnlyHint: true`)이다. 범위를 받는 도구는 `scope`를 쓴다.

```json
{ "project": "TRS", "kind": "archive" }
{ "kind": "collection", "name": "증강 요법" }
{ "kind": "topic", "name": "장기 예후" }
{ "kind": "character", "character": "method" }
{ "kind": "ids", "ids": ["…"] }
{ "kind": "shelf" }
```

`kind`의 기본은 프로젝트 아카이브다. `character`는 논문 유형(`R` 종설·논평, `M` 체계적 고찰·메타분석, `O` 원저)이나 기여(`concept`, `origin`, `debate`, `method`, `primary`, `rebuttal`)다. `shelf`만 프로젝트 밖(서고 전체)을 본다.

| 도구 | 하는 일 |
|---|---|
| `list_projects` | 프로젝트, 연구 질문, 아카이브 편수, 연결된 폴더 |
| `list_scopes` | 컬렉션·소주제와 편수, 유형·기여별 편수 |
| `list_works` | 범위의 문헌: 서지, 유형·기여, PDF·색인 여부, 근거 표 앞 열 |
| `resolve_works` | DOI → PMID → 제목+연도 순으로 라이브러리 문헌 찾기. 프로젝트 상태, PDF·색인 여부 |
| `find_support` | 주장 문장에 관한 구절(문헌당 최대 2개): 쪽, 섹션, 점수. 뒷받침·반박 판정은 하지 않는다 |
| `search_passages` | 자유 질의로 구절 찾기(문헌당 최대 3개) |
| `get_passages` | 한 문헌의 구절을 읽는 순서로, 쪽 범위 지정 가능 |
| `get_evidence` | 한 문헌의 근거 표 칸: 값, 원문 인용, 쪽, 비운 이유 |
| `get_bibtex` | BibTeX. `keys`로 원고의 citekey를 정한다. PMID가 있으면 `pmid` 필드를 넣는다 |

구절 검색은 로컬 Ollama(서고 설정의 임베딩 모델)가 켜져 있으면 의미 + 단어, 꺼져 있으면 단어로만 찾는다. 결과의 `semantic`이 그 여부다. 영어 주장문이 가장 잘 맞는다.

응답은 `structuredContent`(JSON)와 같은 내용의 텍스트를 함께 준다. 잘못된 인자나 없는 프로젝트·컬렉션은 `isError: true`와 고칠 방법을 담은 메시지로 돌아온다.

## 호출 기록

호출마다 한 줄(시각, 도구, 인자 요약, 걸린 시간, 성공 여부)을 JSONL로 남긴다. 긴 문자열은 잘리고 키처럼 보이는 값은 가려진다. 2 MB를 넘으면 `.1`로 돌린다.

## 아직 없는 것

계획 9절의 7–8단계 도구(`search_conversations`, `request_fulltext`, `job_status`)는 아직 없다. 커넥터는 지금 아무것도 쓰지 않는다.
