# ResearchBunny 코드 감사: 잠재 버그와 효율 개선 제안

- 대상: `main` 기준 0.3.28 (`fcc4f31`), `src/` 전체 약 38,000줄과 `scripts/`
- 작성일: 2026-11-18
- 방법: 여섯 영역(메인·플랫폼 / DB·내보내기 / shelf·passages / 전문 확보·검색·탐색 / 계보 리포트·AI 연동 / 렌더러)으로 나눠 해당 파일을 전부 읽고 호출 경로를 따라가며 확인했다. 앱과 테스트는 실행하지 않았다. BibTeX 관련 4건만 임시 스크립트로 재현했다.

## 신뢰도 표기

| 표기 | 뜻 |
|---|---|
| **확인** | 코드 경로를 끝까지 읽어 논리가 성립함을 확인. ★가 붙은 항목은 작성 단계에서 소스를 한 번 더 대조했다 |
| **재현** | 임시 스크립트로 실제 출력까지 확인 |
| **유력** | 코드 경로는 분명하나 발생 여부가 타이밍·외부 서비스·WebKit 동작에 달려 있음 |
| **추정** | 가능성은 있으나 유발 조건을 확인하지 못함 |

실행으로 재현한 것은 "재현" 표기 항목뿐이다. 나머지는 모두 코드 읽기에 근거하므로, 고치기 전에 해당 시나리오를 테스트로 먼저 고정하기를 권한다.

---

## 1. 먼저 고칠 것 (우선순위 12건)

데이터 손실·영구 고착·잘못된 데이터 저장 순으로 골랐다.

| # | 항목 | 한 줄 요약 | 상세 |
|---|---|---|---|
| 1 | Keychain 읽기 실패 뒤 키 하나 저장 → 나머지 비밀 전부 삭제 | 읽기 실패와 "항목 없음"을 구분하지 않고 빈 상태로 덮어쓴다 | M-1 |
| 2 | 병합이 제거되는 문헌의 서지·프로젝트 상태를 버림 | `{...remove, ...keep}`에서 keep의 null이 이긴다 | D-1 |
| 3 | 병합 되돌리기가 18개 테이블을 통째로 되돌림 | 그 사이 만든 리포트 문헌·카드·실행 기록이 사라질 수 있다 | D-3, D-9 |
| 4 | 다운로드 복구 모니터가 앱을 BUSY로 만듦 | 실패 항목 하나만 있어도 "작업 진행 중"으로 거부된다 | F-1 |
| 5 | HTML 링크에서 긁은 PDF를 동일성 검증 없이 첨부 | DOI 없는 문헌에 엉뚱한 PDF가 "검증됨"으로 붙는다 | F-2 |
| 6 | 원본이 사라진 중복 파일이 승격되지 않음 | 논문이 첨부·본문 검색·임베딩에서 모두 빠진다 | S-1 |
| 7 | `missing` 행과 UNIQUE 충돌로 정리 배치 중단 | 파일은 이미 옮겨졌는데 DB·로그는 기록되지 않는다 | S-2 |
| 8 | 청커가 첫 "References" 뒤를 전부 버림 | Nature 계열의 Methods, 편저의 뒷 장이 색인되지 않는다 | P-1 |
| 9 | 범위 지정 본문 검색에서 키워드 절반이 사라짐 | 전역 상위 400개를 뽑은 뒤에 폴더로 거른다 | P-2 |
| 10 | 공급자 장애가 모든 카드를 "failed"로 만들고 단계는 완료 처리 | 재개해도 카드를 다시 만들지 않는다 | G-1 |
| 11 | 목차를 고쳐도 뒤 단계가 무효화되지 않음 | 이름이 바뀐 장이 렌더 결과에서 조용히 빠진다 | G-3 |
| 12 | 서비스 무한 재시작과 진단 로그 부재 | 1초마다 프로세스를 다시 띄우고 원인은 버린다 | M-3, M-10 |

효율 쪽에서 효과가 가장 큰 것은 다음 다섯이다.

1. 읽기 전용 명령이 `changed`를 내보내 전체 새로고침을 유발 (E-1)
2. `list()`가 페이지마다 범위 전체를 읽고 JSON 파싱 (E-2)
3. `prepare()`가 약 390곳에서 매번 새로 컴파일됨: 래퍼 한 곳 수정으로 해결 (E-3)
4. 그래프 요청이 노드마다 전체 Work 레코드를 전송 (E-4)
5. Codex 호출이 완전 직렬이고 호출마다 프로세스와 설정 왕복을 새로 함 (E-13)

---

## 2. 잠재 버그

### 2.1 메인 프로세스 · 플랫폼 · 서비스 진입점 (M)

**M-1. Keychain 읽기 실패 뒤 키 저장이 다른 비밀을 지운다** — 확인★
- 위치: `src/platform/credentials.ts:26-42`(load), `51-77`(save)
- 현상: `load()`는 모든 실패(프롬프트 거부, 잠긴 키체인, 헬퍼 오류, 스키마 불일치)를 `secrets = { secureStorage: false }`로 처리한다. 이후 `save()`는 이 빈 상태에서 `next`를 만들어 Keychain 항목 전체를 덮어쓴다. 사용자가 OpenAI 키만 다시 넣으면 openalex·ollama·pubmed·tinyfish 키와 `browser` AES 키가 사라진다. 다음 실행에서 `ensureBrowserKey()`가 새 키를 만들므로 `chrome-session.bin`을 복호화할 수 없어 기관 로그인 세션도 잃는다.
- 해결: "항목 없음"(value null)과 "읽기 실패"를 구분해 저장한다. 읽기에 실패한 상태에서는 `save()`가 거부하거나, 헬퍼 안에서 읽기-병합-쓰기를 한 번에 수행한다. `native()`에 타임아웃을 두고, 창을 Keychain 읽기보다 먼저 띄운다.

**M-2. 모든 명령에 300초 고정 타임아웃, 타임아웃 뒤에도 작업은 계속된다** — 확인
- 위치: `src/platform/service-host.ts:132-141`, `src/renderer/bridge.ts:7`, `src/main/index.ts:262`
- 현상: 백업은 PDF마다 해시·복사·재해시로 세 번 읽는다. 수천 편이거나 SMB 서고면 5분을 넘긴다. UI는 타임아웃을 표시하지만 서비스는 계속 쓰고, `busy()`가 백업을 포함하지 않아 다시 누르면 두 번째 백업이 동시에 돈다. 복원이 타임아웃되면 `libraries/restored-<uuid>`가 채택도 삭제도 되지 않고 남는다. 렌더러 타이머는 클릭 시점에 시작하므로 파일 대화상자에 머문 시간도 포함된다.
- 해결: 백업·복원·PDF 내보내기·서고 편입·정리 적용을 작업(job)으로 바꾼다. 즉시 작업 id를 돌려주고 진행은 이벤트로, 취소를 지원하고 `busy()`에 포함한다. 최소한 명령별 타임아웃을 두고, 타임아웃 시 서비스에 취소를 보낸다.

**M-3. 서비스 재시작에 백오프와 횟수 제한이 없고, 시작 실패 원인이 버려진다** — 확인★
- 위치: `src/platform/service-host.ts:42-43, 89-117`, `src/service/index.ts:4`
- 현상: 자식이 종료되면 1초 뒤 무조건 다시 시작한다. 볼륨 분리, 손상된 DB, 더 높은 스키마 같은 결정적 실패에서는 1초마다 새 Bun 프로세스를 영원히 띄운다. 자식의 stderr는 버려지므로 `NEWER_SCHEMA` 같은 구체적 메시지 대신 일반 문구만 보인다. 20초 시작 타이머는 느린 디스크에서 초기화 중인 자식을 죽이고 다시 반복한다.
- 해결: 지수 백오프와 상한(예: 5회 뒤 지속 오류 표시 후 중단). 서비스가 생성자 오류를 잡아 `{ fatal: { code, message } }`를 IPC로 보낸 뒤 종료한다. 첫 시작 실패는 자동 재시작하지 않는다.

**M-4. 남은 Electron `SingletonLock` 심볼릭 링크가 실행을 영구히 막을 수 있다** — 확인(해당 링크가 남아 있는 경우만)
- 위치: `src/platform/instance.ts:23-47`
- 현상: 링크의 pid가 살아 있기만 하면 `ALREADY_RUNNING`을 던진다. 그 pid가 ResearchBunny인지 확인하지 않고 오래된 링크도 지우지 않는다. pid가 재사용되면 실행 중인 앱이 없는데도 시작을 거부한다.
- 해결: 실제 뮤텍스는 `.electrobun.lock`의 flock이므로 레거시 검사를 삭제한다. 남긴다면 `chrome-host.ts:108-121`처럼 `ps`로 명령줄을 확인하고 불일치 시 링크를 지운다.

**M-5. 백업 복원이 롤백 없이 라이브러리를 전환한다** — 확인(발생 확률 낮음)
- 위치: `src/main/index.ts:209-213`
- 현상: 서비스를 멈추고 `library-location.json`을 먼저 쓴 뒤 새 서비스를 시작한다. 시작이 실패해도 앱은 이미 새 라이브러리를 가리키고, M-3의 재시작 루프가 그 위에서 돈다.
- 해결: 복원된 경로에서 서비스가 `ready`와 init까지 성공한 뒤에만 위치 파일을 쓴다. 실패하면 이전 루트로 되돌리고 복원 폴더를 지운다.

**M-6. 종료 시간 예산이 맞지 않는다** — 확인(영향 낮음)
- 위치: `src/platform/service-host.ts:156-170`, `src/service/index.ts:16-19`, `src/service/fulltext/chrome-host.ts:193-204`
- 현상: 호스트는 4초 뒤 자식을 죽이는데, 서비스 쪽 정리는 최대 5.5초가 걸린다. 서비스에 SIGTERM 핸들러가 없어 `db.close()`가 생략되고(WAL 미체크포인트) 쿠키 저장이 끊겨 세션을 잃을 수 있다. `stop()`은 자식의 exit를 기다리지 않는다.
- 해결: 종료 함수를 하나로 합치고 플래그로 중복 실행을 막는다. 호스트 예산을 서비스 예산의 합보다 크게 잡고, exit 이벤트를 기다린 뒤에 SIGKILL한다. 서비스에 SIGTERM 핸들러를 추가한다.

**M-7. 네이티브 파일 대화상자가 메인 프로세스 JS 스레드 전체를 막는다** — 확인
- 위치: `src/platform/native.ts:55-67`, `src/native/dialogs.swift:43-47`
- 현상: 패널이 열려 있는 동안 진행 이벤트, 다른 RPC 응답, 타이머가 모두 멈춘다.
- 해결: `begin(completionHandler:)`로 비동기화하거나, 대화상자를 기존 헬퍼 실행 파일로 옮겨 `await`가 실제로 비동기가 되게 한다.

**M-8. 두 번째 실행이 첫 인스턴스를 활성화하기 전에 종료될 수 있다** — 유력
- 위치: `src/platform/instance.ts:53-61`, `src/main/index.ts:334-337`
- 현상: flock 실패 시 소켓 연결을 기다리지 않고 바로 종료한다. 소켓이 `$TMPDIR`에 있어 macOS의 주기적 정리로 사라질 수 있다. flock 실패 원인을 구분하지 않아 다른 오류도 "이미 실행 중"으로 조용히 끝난다.
- 해결: `connect` 또는 `error`를 최대 500ms 기다린 뒤 종료한다. 소켓을 데이터 폴더의 잠금 파일 옆에 둔다. errno를 구분한다.

**M-9. 휴지통 복원이 원자적이지 않고 논문마다 되돌리기 기록을 만든다** — 확인
- 위치: `src/service/service.ts:352-359`
- 현상: 50편을 복원하면 트랜잭션 50개와 변경 기록 50건이 생겨 되돌리기는 마지막 한 편만 되돌린다. 중간에 잘못된 id가 있으면 부분 복원으로 끝난다.
- 해결: 루프를 하나의 트랜잭션으로 감싸고 변경 기록을 하나만 쓴다.

**M-10. 진단 수단이 없다** — 확인
- 위치: `src/main/index.ts:309-321`, `src/service/index.ts:22-37`
- 현상: AppError가 아닌 오류(ZodError, 실제 버그)는 로그 없이 일반 오류로 바뀐다. 서비스에 `unhandledRejection`/`uncaughtException` 핸들러가 없어 떠돌이 rejection 하나가 진행 중인 모든 작업과 함께 서비스를 종료시키고 이유는 남지 않는다.
- 해결: 데이터 폴더에 작은 순환 로그 파일을 두고 두 프로세스가 비밀을 가린 채 기록한다. 두 catch 블록에서 스택을 남기고, 서비스에 전역 핸들러를 추가한다. **이 항목은 다른 모든 버그의 현장 진단을 가능하게 하므로 일찍 넣을 가치가 있다.**

**M-11. ServiceHost의 작은 누수** — 확인(영향 낮음)
- `child.send`가 던지면 pending 항목과 300초 타이머가 남는다(`service-host.ts:130-149`). `stop()`이 `this.child = null`로 만들어 `ready`를 기다리던 `start()` Promise가 영원히 미결로 남는다.

**M-12. 렌더러가 보낸 절대 경로를 검증 없이 서비스로 전달** — 확인(방어 강화 항목)
- 위치: `src/shared/contracts.ts:54, 224, 290, 359`
- 현상: `downloadDirectory`, 리포트 `workspace`, 서고 경로는 대화상자가 돌려준 값을 렌더러가 평문으로 다시 보낸다. 서비스는 이 경로에서 이동·삭제를 한다.
- 해결: 호스트가 자기 대화상자가 돌려준 경로(또는 이미 승인된 저장 경로)의 집합을 유지하고 그 밖의 값은 거부한다.

**M-13. 기타** — 확인
- `bridge.ts:11-13`: 리스너 하나가 던지면 나머지 리스너에 이벤트가 전달되지 않는다.
- `main/index.ts:338-354`: `library-location.json`이 분리된 디스크를 가리키면 "다른 위치 선택"이나 "재시도" 없이 치명적 오류로 끝난다.
- `service.ts:993-995`: 내보내기에서 rename이 실패하면 `*.staging` 파일이 남는다.

### 2.2 데이터베이스 · 가져오기/내보내기 (D)

**D-1. 병합이 제거되는 레코드의 서지와 프로젝트 상태를 버린다** — 확인★
- 위치: `src/service/db/merge.ts:49-67, 137-146`
- 현상 (a): `{...remove, ...keep, doi, openalex, references, bibFields}`에서 네 필드만 합쳐진다. 서지가 빈 PDF·BibTeX 임시 레코드를 남기고 OpenAlex 레코드를 제거하면 초록·PMID·연도·주제·인용 수·OA 링크가 사라진다.
- 현상 (b): `k = db.state(project, keepId)`는 keep이 그 프로젝트의 구성원이 아니면 기본 상태를 돌려주고, 이것이 제거되는 쪽의 `excluded`·`trash`·`read` 상태를 덮는다. 병합 결과가 그 프로젝트의 검토 대기함에 `pending`으로 나타난다.
- 해결: 필드 단위로 합친다(`keep.x ?? remove.x`, 빈 배열과 빈 문자열은 없는 값으로 취급). 상태는 keep의 `project_works` 행이 실제로 있을 때만 `k`가 이기게 한다.

**D-2. BibTeX 내보내기 후 가져오기가 밑줄이 든 DOI를 망가뜨린다** — 재현
- 위치: `src/service/interchange/bibtex.ts:143-148, 184-185, 116`, `src/shared/domain.ts:3-11`, `src/workers/pdf.ts:129-135`
- 현상: `exportBib`가 `doi`와 `url`에도 `escapeBib`를 적용해 `_`가 `\_`가 된다. 다시 가져오면 `10.1000/a\_b`가 DOI로 저장되어 원래 레코드와 맞지 않고 중복 문헌이 생긴다(Springer 장 DOI 대부분이 해당). 그 밖에 끝의 마침표가 남고, `doi.org/…`(스킴 없음), `www.doi.org`, `%2F` 인코딩은 null이 되어 DOI가 조용히 버려진다. 워커는 소문자화 전에 중복을 제거하므로 대소문자만 다른 같은 DOI를 2개로 세어 조회를 건너뛴다.
- 해결: `normalizeDoi`에 TeX 이스케이프·중괄호 제거(`fulltext/engine.ts`의 `cleanDoi` 로직을 옮김), 스킴 없는 `doi.org` 허용, URL 디코드, 끝 문장부호 제거를 넣는다. `exportBib`는 `doi`와 `url`을 이스케이프하지 않는다. 기존 `identifiers`의 doi 행을 한 번 재정규화한다.

**D-3. 병합 되돌리기가 18개 테이블을 통째로 다시 쓴다** — 확인(손실은 유력)
- 위치: `src/service/db/merge.ts:10-29, 164-205`
- 현상: 되돌리기는 `revision`이 같을 때만 허용되는데, `saveRun`, `candidate`, `updateEvidence`, `GenealogyStore.savePaper/saveCard`, `import_items` 삽입, `export_records`는 `touch()`를 부르지 않는다. 병합 뒤 계보 리포트를 만들거나 다운로드·내보내기를 하고 되돌리면 그 사이의 리포트 문헌·카드·실행 기록이 병합 전 내용으로 교체된다.
- 해결: 테이블 전체 스냅샷을 그만두고 병합이 실제로 바꾼 행만 기록해 복원한다(D-9와 같은 수정). 임시로는 `TABLES`에 속한 테이블에 쓰는 모든 경로가 revision을 올리게 한다.

**D-4. 병합이 제거되는 문헌의 채팅을 고아로 만든다** — 확인
- 위치: `src/service/db/merge.ts`(처리 없음), `src/service/chat/store.ts:43-63`
- 해결: 병합 트랜잭션 안에서 `chat_threads.work_id`를 keep으로 옮기고 `article-chat:` 환경설정 키도 바꾼다. 되돌리기 기록에 포함한다.

**D-5. 백업 복원이 서고·연결 첨부의 경로를 모두 바꾼다** — 확인(결과는 유력)
- 위치: `src/service/interchange/backup.ts:160-188`
- 현상: "연결 파일 포함" 없이 만든 백업을 같은 기기에서 복원하면, 파일이 제자리에 있는데도 모든 서고 PDF의 경로가 `<dest>/missing/<id>.pdf`로 바뀌어 누락으로 표시된다. 포함해서 만든 백업은 모든 서고 PDF를 앱 데이터 폴더에 복제하고 `managed`로 바꾸지만 `shelfFileId`는 그대로 서고 파일을 가리킨다.
- 해결: 매니페스트에 파일이 없으면 원래 경로를 유지하고 `exists`만 실제 상태를 반영한다. `shelfFileId`가 있는 첨부는 경로를 바꾸지 않고, 복원 뒤 모든 서고 파일에 `ensureAttachment`/`syncAttachmentPath`를 돌린다.

**D-6. DOI를 고쳐도 이전 DOI가 그 문헌에 묶여 남는다** — 확인★
- 위치: `src/service/db/database.ts:602-628`
- 현상: `edit()`는 새 DOI를 `INSERT OR IGNORE`만 하고 이전 식별자 행을 지우지 않는다. 잘못 붙은 B 논문의 DOI를 고친 뒤 B를 가져오면 매번 `IDENTITY_CONFLICT`가 나서 B를 영영 가져올 수 없다.
- 해결: `doi`가 패치에 있으면 삽입 전에 `DELETE FROM identifiers WHERE provider='doi' AND work_id=? AND value!=?`를 실행한다.

**D-7. 서지가 빈약한 출처의 기본값이 권위 있는 필드를 덮는다** — 확인(BibTeX 경로)
- 위치: `src/service/db/database.ts:307-333`, `src/shared/domain.ts:143-172`
- 현상: OpenAlex로 이미 알려진 문헌의 .bib 항목을 다시 가져오면 `retracted: true`가 false로, `type`이 BibTeX 항목 유형으로, `raw`(OpenAlex 페이로드)가 `{}`로, `source`가 `bibtex`로 바뀐다. 철회 논문 숨김 필터가 더 이상 그 논문을 숨기지 않는다.
- 해결: 출처 신뢰 순위에 따른 필드별 우선순위를 둔다. 신뢰도가 낮은 출처(bibtex, pdf, manual)는 비어 있는 필드만 채우고 `retracted`·`type`·`raw`는 건드리지 않는다.

**D-8. 없어진 문헌을 가리키는 상태 변경에서 되돌리기 스택이 영구히 막힌다** — 확인
- 위치: `src/service/db/database.ts:579-600, 492`
- 현상: X에 별표를 주고 X를 Y로 병합한 뒤 되돌리기가 그 기록에 닿으면 `NOT_FOUND`로 트랜잭션이 롤백되고 기록은 남는다. 이후 그 프로젝트의 모든 되돌리기가 같은 기록에서 실패한다.
- 해결: 상태 분기에서 없는 문헌은 건너뛰고(컬렉션 분기는 이미 그렇게 한다) 기록은 항상 지운다. 또는 병합 시 `changes.data`의 id를 keep으로 바꾼다.

**D-9. 병합 스냅샷이 DB 대부분을 하나의 JSON 문자열로 만든다** — 확인★(크기 임계는 미측정)
- 위치: `src/service/db/merge.ts:36-45, 159-161`
- 현상: 병합할 때마다 18개 테이블을 `SELECT *`로 읽어 서비스 스레드에서 동기적으로 직렬화한다. 서고 규모 라이브러리에서는 수십~수백 MB가 되어 UI가 멈추고, 이 사본이 DB와 모든 백업에 포함된다. 약 1GB를 넘으면 `SQLITE_MAX_LENGTH`로 병합 자체가 실패한다.
- 해결: D-3과 동일한 행 단위 되돌리기 기록.

**D-10. 영구 삭제가 탐색 외 실행의 `run.count`를 덮어쓴다** — 확인
- 위치: `src/service/db/trash.ts:145-150`
- 현상: 휴지통을 비우면 그 프로젝트의 다운로드 실행과 "PDF 폴더 연결" 실행의 완료 수가 0으로 표시된다.
- 해결: `download`·`import`가 없는 실행만 다시 계산한다.

**D-11. PDF 가져오기가 `IDENTITY_CONFLICT`를 삼키고 임시 중복 레코드를 만든다** — 확인
- 위치: `src/service/interchange/pdf.ts:307-341`
- 해결: 이 오류를 따로 잡아 충돌 메시지와 함께 실패·건너뜀으로 기록하거나 일치한 레코드에 첨부한다.

**D-12. `splitBib`가 citekey 안의 `)`에서 항목을 자른다** — 재현
- 위치: `src/service/interchange/bibtex.ts:41-46`
- 현상: `@article{10.1016/S0140-6736(20)30183-5, …}`가 구문 오류로 통째로 건너뛰어진다. DOI 형식 citekey는 출판사 내보내기에서 흔하다.
- 해결: 블록을 연 구분자를 기억해, `(`로 연 블록에서만 `)`를 닫는 문자로 취급한다.

**D-13. `escapeBib`가 백슬래시를 망가뜨린다** — 재현
- 위치: `src/service/interchange/bibtex.ts:143-148`
- 현상: `a\b`가 `a\textbackslash\{\}b`로 내보내진다(뒤의 중괄호 치환이 앞 단계 결과를 다시 이스케이프).
- 해결: 문자 맵을 쓰는 단일 패스 치환.

**D-14. 실패한 PDF 가져오기의 재시도가 파일 이름만으로 맞춘다** — 확인(영향 낮음)
- 위치: `src/service/interchange/pdf.ts:476-489`
- 현상: `A/paper.pdf`는 성공하고 `B/paper.pdf`는 실패했다면 재개가 둘 다 다시 가져온다.
- 해결: 전체 경로를 저장하고 그것으로 거른다.

**D-15. 문헌을 영구 삭제해도 managed PDF가 `attachments/`에 남는다** — 확인(디스크 누수)
- 위치: `src/service/db/trash.ts:50-56`
- 해결: 트랜잭션 뒤, `mode='managed'`이고 경로가 라이브러리 안이며 같은 해시를 가진 첨부 행이 더 없으면 파일을 지운다. 또는 시작 시 청소한다.

**D-16. 마지막 `saveRun`이 던지면 가져오기 슬롯이 계속 점유된다** — 추정
- 위치: `src/service/interchange/pdf.ts:239-243, 461-465`. 같은 패턴이 `fulltext/jobs.ts:394-402`, `discovery/engine.ts:286-293`에도 있다.
- 현상: `active.set`이 try 밖에 있고, `finally`에서 `saveRun`이 `active.delete`보다 먼저 실행된다. 디스크 가득 참 등으로 쓰기가 실패하면 재시작 전까지 가져오기·병합·백업·프로젝트 삭제가 모두 거부된다.
- 해결: `active.delete`와 `emit`을 안쪽 `finally`에 둔다.

**D-17. 마이그레이션 경로가 없고 스키마 버전을 무조건 찍는다** — 추정(현재 버그가 아닌 위험)
- 위치: `src/service/db/database.ts:53-60, 123`
- 현상: 생성자가 매번 `CREATE TABLE IF NOT EXISTS …; PRAGMA user_version=3`을 실행한다. 기존 테이블의 열을 처음 바꾸는 날, 기존 라이브러리에는 적용되지 않으면서 최신으로 표시된다.
- 해결: `user_version`을 먼저 읽고 순서대로 마이그레이션을 한 트랜잭션에서 실행한 뒤 성공했을 때만 버전을 쓴다.

### 2.3 서고(shelf) (S)

**S-1. 원본이 사라져도 중복 사본이 승격되지 않는다** — 확인
- 위치: `src/service/shelf/indexer.ts:644-650, 1008, 1190-1203, 540-547`
- 현상: 같은 해시의 두 번째 파일은 `duplicateOf`가 붙고, 이 값은 사본 자신의 크기·mtime이 바뀔 때만 지워진다. (a) Finder에서 원본을 지우고 사본을 남기면 그 논문은 사용할 수 있는 첨부가 없고, 본문 색인·검색, `heldBy`(그래서 다시 다운로드될 수 있음), 폴더 수, 임베딩에서 빠진다. (b) 정리 기능이 원본을 `_duplicated`로 옮기고 `release()`하면 남은 사본의 `duplicateOf`가 허공을 가리킨다. (c) 파일의 20% 넘게 이름이 바뀌거나 NFC/NFD 표기가 뒤집히면 확인 대기 중에도 새 경로를 색인해 전부 고아 중복이 된다.
- 해결: 원본이 missing·release·hidden·forgotten이 될 때 같은 트랜잭션에서 첫 번째 남은 사본을 승격한다(`json_remove(info,'$.duplicateOf')`, 다른 사본 재지정, `ensureAttachment`). `applyScan` 끝에 대상이 없는 `duplicateOf`를 고치는 단계를 넣는다. 누락 확인이 대기 중일 때는 새 파일을 해시하지 않는다.

**S-2. 파일이 이미 옮겨진 뒤 오래된 `missing` 행이 UNIQUE(root_id, rel_path)와 충돌한다** — 확인
- 위치: `src/service/shelf/sorter.ts:820-832`, `src/service/shelf/indexer.ts:1180, 813-824`
- 현상: `freeName`은 디스크만 확인한다. 예전에 지워진 `Leaf/X.pdf`의 missing 행이 남아 있으면 rename은 성공하고 `relocate`가 제약 오류를 던진다. 이 예외가 `move()` 루프 전체를 빠져나가 남은 승인 파일은 옮겨지지 않고 인테이크 로그와 `index.json`도 쓰이지 않는다. `deposit`에서는 PDF가 서고에 들어갔는데 다운로드가 실패로 보고된다. missing 행을 지우는 코드는 어디에도 없다.
- 해결: `relocate`와 `deposit`의 트랜잭션 안에서 대상 경로의 행을 먼저 조회해, missing이면 재사용하거나(문헌·첨부를 옮긴 뒤) 삭제한다. `move()`의 파일별 DB 단계를 try/catch로 감싸 한 건의 실패가 배치 전체를 중단하지 않게 한다. N일 지난 missing 행은 정리한다.

**S-3. mtime만 바뀌어도 전체 파이프라인을 다시 돌리고 수동 결정을 덮어쓴다** — 확인
- 위치: `src/service/shelf/indexer.ts:527-531, 652, 680, 729-751`
- 현상: 서고를 mtime 보존 없이 새 디스크로 복사하거나 동기화 도구·SMB가 타임스탬프를 건드리면, 해시가 같아도 모든 파일을 다시 해시·추출·해석한다(약 8,000편 전체 읽기 두 번과 OpenAlex 크레딧 수천). 사용자가 손으로 정한 것(`keepProvisional`, `linkFile`, `resolveManually`)도 다시 해석기를 거쳐 `review`로 강등되거나 다른 문헌으로 옮겨질 수 있다.
- 해결: `afterHash`에서 해시가 같으면 `hashed_size`/`hashed_mtime`만 갱신하고 이전 단계를 복원한다. `afterExtract`에서 `manual`을 `hash`/`app`과 같이 취급한다.

**S-4. 걷기 중 lstat 오류가 있는 파일을 `missing`으로 만든다** — 확인★
- 위치: `src/service/shelf/scanner.ts:65`
- 현상: `lstat(...).catch(() => null)`이 모든 오류를 "파일 없음"으로 처리한다. 불안정한 SMB 세션이 일부 파일에 EIO/ETIMEDOUT을 돌려주면 20% 미만일 때 확인 없이 missing으로 표시된다.
- 해결: ENOENT만 삼키고 그 밖의 오류에서는 걷기를 중단한다(readdir 실패가 이미 그렇게 한다).

**S-5. `confirmMissing` 승인이 다음 스캔까지 남는다** — 확인
- 위치: `src/service/shelf/indexer.ts:362, 374-377, 519, 548`
- 현상: 다른 패스가 도는 중이거나 일시정지 상태에서 확인하면 플래그가 메모리에 남아, 최대 30분 뒤의 다음 걷기를 내용과 무관하게 미리 승인한다.
- 해결: 승인을 보여준 내용(누락 수나 스캔 id)에 묶고, 다음 계획이 다르면 버린다.

**S-6. 빈 이름 확인 뒤의 `rename()`이 PDF를 조용히 덮어쓸 수 있다** — 확인(경합 창은 수 ms, 유발은 추정)
- 위치: `src/service/shelf/indexer.ts:813-814`, `src/service/shelf/sorter.ts:820-824`
- 현상: 다운로드와 PDF 가져오기는 별도의 `active` 맵을 가지고 동시에 deposit할 수 있다. 서로 다른 두 PDF가 같은 `연도 - 저자 - 제목.pdf`로 포맷되면 두 번째 rename이 첫 파일을 덮어쓴다.
- 해결: `link(temp, final)` + `unlink(temp)` 또는 `COPYFILE_EXCL`로 배치하고 EEXIST면 다음 이름으로 재시도한다. `deposit`을 작은 뮤텍스로 직렬화한다.

**S-7. 거부된 두 번째 이동이 `ShelfSorter.applying`을 해제한다** — 확인
- 위치: `src/service/shelf/sorter.ts:776, 790, 861-863`
- 해결: `move()` 맨 위에서 `applying`이면 BUSY를 던지고, 플래그를 세운 호출만 해제한다.

**S-8. 일시적 추출 실패(15초 타임아웃)가 영구 결과로 저장된다** — 확인
- 위치: `src/service/shelf/indexer.ts:599-606, 664-689`
- 현상: SMB에서 큰 PDF가 15초를 넘기면 `pages: null`인 채로 단계가 진행되어 그 파일은 파일 이름만으로 영구히 해석된다.
- 해결: 추출기가 실패 사유(타임아웃 / 워커 종료 / 파싱 오류)를 돌려주고, 파싱 오류만 확정한다. 타임아웃은 시도 횟수와 함께 단계를 유지하고 파일 크기에 비례해 타임아웃을 늘린다.

**S-9. 실패하는 임베딩 배치 하나가 뒤의 모든 임베딩을 막는다** — 확인(구조), 유발은 유력
- 위치: `src/service/shelf/indexer.ts:1284-1295`, `src/service/passages/indexer.ts:269-275`
- 현상: Ollama가 특정 입력에 연결 외 오류를 돌려주면 매 패스가 같은 배치에서 멈춰, 정렬상 그 뒤의 논문과 구절은 벡터를 영영 얻지 못한다.
- 해결: 서버가 살아 있는 상태의 오류면 배치를 항목별로 재시도하고, 실패 항목은 시도 횟수를 기록해 건너뛴다. `OLLAMA_OFFLINE`과 `OLLAMA_MODEL`에서만 패스를 멈춘다.

**S-10. LLM 출력을 전부 아니면 전무로 받는다** — 확인
- 위치: `src/service/shelf/sorter.ts:61-68, 294-301`, `src/service/passages/answer.ts:21, 25-33, 120, 147-148`
- 현상: 결정 하나의 `leaf: 0`이나 400자 넘는 이유가 배치 전체를 거부한다. 답변에서는 출처 5개, 600자 넘는 인용, 다섯 번째 검색어 하나가 최대 220초짜리 호출 결과 전체를 버리게 한다.
- 해결: 관대하게 파싱한 뒤 자른다(항목별 검증, 배열 slice, 문자열 절단, 잘못된 항목만 제거). 정리에서는 유효한 결정이 없는 논문만 다시 묻는다.

### 2.4 본문 구절(passages) (P)

**P-1. 청커가 첫 "References" 제목 뒤를 전부 버린다** — 확인★(실제 PDF 영향은 미측정)
- 위치: `src/service/passages/chunker.ts:149`
- 현상: 텍스트의 25%를 지난 뒤 References 제목을 만나면 바로 `return`한다. Nature 계열(본문 → References → Methods / Extended Data), 참고문헌 뒤에 부록이 있는 논문, 장마다 참고문헌이 있는 편저·프로시딩에서 그 뒤가 색인되지 않는다. 문서는 `ok`로 저장되어 UI는 전체를 다뤘다고 표시한다.
- 해결: References를 BACK_MATTER처럼 취급해 `skipping = true`로 두고 다음 NAMED_SECTION 제목이나 더 큰 글자의 제목에서 재개한다. 참고문헌 항목 "12. Smith …"가 맞을 수 있으므로 NUMBERED_HEADING만으로는 재개하지 않는다. `CHUNKER_VERSION`을 올린다.

**P-2. 범위 지정 검색에서 키워드 결과가 사라진다** — 확인★
- 위치: `src/service/passages/search.ts:73`, `src/service/passages/store.ts:197-201`
- 현상: OR 질의의 전역 BM25 상위 400개를 뽑은 다음 폴더 범위로 거른다. 40만 구절 색인에서 20편짜리 폴더를 지정하면 상위 400개에 그 폴더의 구절이 거의 없어, 답변이 임베딩에만 근거하게 된다(Ollama가 꺼져 있으면 근거가 아예 없다). 의미 검색 쪽은 스캔 안에서 거른다.
- 해결: 허용 해시를 SQL에 넣는다(`AND p.hash IN (SELECT value FROM json_each(?))`). 중복·누락 해시도 LIMIT 전에 거른다.

**P-3. 추출 타임아웃이 영구 실패로 저장된다** — 확인
- 위치: `src/service/passages/indexer.ts:310-319`
- 현상: 180초 창에서 느린 NAS나 노트북 절전으로 타임아웃이 나면 문서가 현재 청커 버전의 `failed`로 저장된다. `todo`는 청커 버전이 다른 문서만 고르고 `passageControl`에는 재시도가 없어 `CHUNKER_VERSION`이 바뀔 때까지 다시 시도하지 않는다.
- 해결: S-8과 같은 사유 구분. "실패 항목 재시도" 동작을 추가한다.

**P-4. 숫자 검사가 근거 있는 숫자를 경고한다** — 확인
- 위치: `src/service/passages/answer.ts:65-68, 212`
- 현상: 구절의 "p < .05"와 진술의 "0.05", "1234"와 "1,234"가 다르다고 판정되어 "근거 없는 숫자" 경고가 붙는다.
- 해결: 비교 전에 양쪽을 정규화한다(천 단위 구분자 제거, `.dd`에 0 추가, 숫자로 비교).

**P-5. 구절 쪽 범위가 다음 쪽으로 이어지는 문단을 무시한다** — 확인
- 위치: `src/service/passages/chunker.ts:179, 233-234, 244`
- 현상: 5쪽 끝에서 시작해 6쪽으로 넘어가는 문단이 "p. 5"로 표시되어, 검증된 인용이 인용 표시에 없는 쪽에 있을 수 있다.
- 해결: 문단별 `pageEnd`를 추적한다.

**P-6. 구절 워커에 파일 크기 상한이 없고 잘림을 알리지 않는다** — 확인
- 위치: `src/workers/pdf.ts:7, 23-26`, `src/service/passages/indexer.ts:311`
- 현상: 500MB 스캔 도서가 워커 두 개에 통째로 올라간 뒤 타임아웃된다. 1,000쪽 또는 400만 자에서 멈추지만 `extracted`로 보고해 범위 수치가 실제보다 크다.
- 해결: 크기 상한 위에서는 건너뛰거나 범위 로딩한다. `truncated` 플래그를 `docs`에 저장한다.

**P-7. 768차원이 아닌 모델의 작은 색인에서 의미 검색이 빈 결과를 낸다** — 확인(영향 낮음)
- 위치: `src/service/passages/store.ts:206-208, 248`
- 해결: 표본이 비면 벡터 행 하나의 길이에서 차원을 읽는다.

### 2.5 전문 확보 (F)

**F-1. 복구 모니터가 앱을 BUSY로 만들고 실행을 이중 처리할 수 있다** — 확인★
- 위치: `src/service/fulltext/jobs.ts:66-73, 172-188`, `src/service/service.ts:241-242, 415-416`
- 현상: 5초마다 `recoverCompleted()`가 실패·대기 항목이 남은 완료 실행을 `this.active`에 등록한다(실행당 최대 30초). `start()`, 재개, `Service.busy()`, `startRun`은 모두 `active.size > 0`을 사용자 작업으로 본다. 오래된 실패 항목 하나만 있어도, 실행 직후 `~/Downloads`의 모든 PDF를 해시·추출하는 몇 분 동안 화면에 아무 작업이 없는데 "원문 확보 작업이 진행 중입니다"가 뜬다. 또 173행의 가드는 `await this.syncHistory()` 앞에서만 확인되어 두 틱이 같은 실행을 동시에 처리할 수 있고, 먼저 끝난 쪽이 스테이징 폴더를 지운다.
- 해결: 복구를 busy 검사에서 제외되는 별도 맵으로 추적하고, `start`/재개가 복구를 중단시키고 진행하게 한다. `recovering` 재진입 플래그를 두고 await 뒤에 `active.size`를 다시 확인한다.

**F-2. HTTP 경로가 동일성 검사 없이 무관한 PDF를 첨부할 수 있다** — 확인
- 위치: `src/service/fulltext/engine.ts:83-92, 375-390`, `src/service/fulltext/jobs.ts:81-92`
- 현상: 랜딩 페이지가 HTML이면 `.pdf`·`/pdf/`·`article-pdf`와 맞는 모든 링크를 후보로 넣고 `requireIdentity` 없이 검증한다. `validate`는 문헌에 DOI가 있고 PDF에 DOI가 정확히 하나 있고 서로 다르며 제목 유사도가 0.5 미만일 때만 거부한다. DOI가 없는 문헌이거나 PDF에 DOI가 0개 또는 여러 개면(저자 지침, 저장소의 다른 논문, 전단) 통과해 "원문 확보 · PDF 검증됨"으로 저장된다.
- 해결: 앵커 수집과 `publisherPdfUrls`로 찾은 후보에는 `requireIdentity: true`를 건다. 관대한 규칙은 `citation_pdf_url`, OpenAlex/Unpaywall `pdf_url`, 직접 OA URL에만 남긴다. 문헌에 DOI가 없으면 항상 제목 유사도를 요구한다.

**F-3. `#`이나 `?`가 든 DOI로 깨진 URL을 만든다** — 확인
- 위치: `src/service/fulltext/engine.ts:404, 406-407`, `src/service/fulltext/chrome.ts:98`
- 현상: `encodeURI(doi)`는 `#`과 `?`를 인코딩하지 않는다. `…CO;2-#`로 끝나는 옛 Wiley SICI DOI에서 Unpaywall의 email 매개변수가 프래그먼트로 들어가고, `doi.org` URL은 잘린 DOI를 조회한다. `sciHubUrl`은 이미 이스케이프하고 있다.
- 해결: `doi.split("/").map(encodeURIComponent).join("/")`를 쓰는 공용 `doiPath()` 하나로 통일한다(`openalex.ts:238`, `doi-org.ts:65`가 이미 이 방식).

**F-4. 15초 요청 타임아웃이 PDF 본문 전체를 덮는다** — 확인
- 위치: `src/service/fulltext/engine.ts:262, 291-335`
- 현상: 25MB 오픈액세스 PDF가 1MB/s면 15초에 중단되고 사용자에게는 일반적인 `FULLTEXT_UNAVAILABLE`만 보인다.
- 해결: `requestMs`는 헤더까지의 시간과 유휴 타임아웃(청크마다 재설정)으로 쓰고 총 시간은 `itemMs`(90초)로 묶는다.

**F-5. `ChromeHost.tab()`이 생성과 연결 사이에 중단되면 창을 흘린다** — 확인
- 위치: `src/service/fulltext/chrome-host.ts:168-178`
- 해결: `createTarget` 이후 단계를 try/catch로 감싸고 실패 시 `Target.closeTarget`을 보낸다.

**F-6. 복원 실패 뒤 세션 쿠키 파일이 삭제될 수 있다** — 유력(기전), 유발은 추정
- 위치: `src/service/fulltext/chrome-host.ts:149, 151, 212-245`
- 현상: `Storage.setCookies`는 전부 아니면 전무인데 오류를 삼킨다. 이후 5분 주기 저장이 파일을 덮어쓰거나, 세션 쿠키가 아직 없으면 지운다. 새 Chrome이 거부하는 쿠키 하나로 모든 기관 SSO 세션을 잃는다.
- 해결: 복원 실패 시 쿠키를 하나씩 재시도하고, 로그인 창이 닫히기 전까지 `saveCookies`의 삭제·덮어쓰기를 막는 플래그를 둔다.

**F-7. 잘린 다운로드를 검증 전에 탐지하지 않는다** — 추정
- 위치: `src/service/fulltext/engine.ts:319-334`, `src/service/interchange/pdf.ts:37-47`
- 해결: Content-Length가 있고 Content-Encoding이 없는데 크기가 다르면 거부한다. 마지막 2KB에서 `%%EOF`를 확인한다.

**F-8. SSRF 방어가 fetch와 따로 DNS를 조회하고 6to4/Teredo 대역을 통과시킨다** — 유력(데스크톱 앱이라 영향 낮음)
- 위치: `src/service/fulltext/engine.ts:38-51, 265-270`
- 해결: 검증한 IP로 연결하거나 피어 주소를 다시 확인한다. `2002::/16`과 `2001::/32`를 제외한다.

**F-9. 기타** — 확인
- `chrome-host.ts:310-316`: `reset()`이 다시 최소화하지 않아 로봇·로그인 확인 한 번 뒤 작업 창이 실행 끝까지 보인다.
- `engine.ts:337-348`: `json()`이 404에도 한 번 재시도해 Unpaywall이 모르는 DOI마다 요청 하나와 600ms를 더 쓴다.
- `engine.ts:14-15`: 개발자 개인 이메일이 모든 출판사·랜딩 호스트로 가는 User-Agent와 Unpaywall 질의의 하드코딩된 기본값이다. 설정 값이나 프로젝트용 주소로 바꾸기를 권한다.
- `jobs.ts:496-498`: 바깥 catch가 오류를 버려 항목별 처리기 밖에서 실패한 실행은 요약 줄만 보인다.

### 2.6 탐색 · 검색 · 공급자 (X)

**X-1. OpenAlex에 없는 seed 하나가 탐색 전체를 실패시키고 재개도 똑같이 실패한다** — 확인★
- 위치: `src/service/discovery/engine.ts:139-148, 408-409, 486-496`, `src/service/providers/openalex.ts:196-200`
- 현상: OpenAlex 레코드가 없는 seed는 `lookup` 작업을 받는데, 404가 `NOT_FOUND`를 던져 실행이 `failed`가 된다. 작업은 완료로 표시되지 않아 재개할 때마다 같은 조회에서 실패한다. 새로 나온 DOI는 며칠~몇 주 OpenAlex에 없다. 완료 메시지("식별자 없는 출발 문헌 N편은 미조회")를 보면 미해결 seed를 허용하려던 설계다.
- 해결: `seedId`가 있는 `lookup`에서 `NOT_FOUND`/`PROVIDER_SCHEMA`를 잡아 작업을 완료 처리하고 `run.seedFailures` 같은 곳에 기록한 뒤 계속한다.

**X-2. PubMed XML 파싱이 잘못된 연도를, 경우에 따라 참고문헌의 DOI를 돌려준다** — 확인(연도), 유력(DOI)
- 위치: `src/service/search/pubmed-search.ts:64-67, 94-98, 110-111`
- 현상: `firstTag(article, "Year")`가 `<PubmedArticle>`의 첫 `<Year>`를 잡는데, efetch XML에서는 `<DateCompleted>`/`<DateRevised>`가 `<PubDate>`보다 앞에 온다. 2005년 논문이 채팅 모델에 "2023"으로 전달된다. `extractDoi`는 레코드 어디서든 첫 doi `ArticleId`를 잡아, 자체 DOI가 없는 논문에서 인용된 논문의 DOI를 돌려줄 수 있다.
- 해결: 연도를 `<PubDate>`(다음은 `<ArticleDate>`, MedlineDate)로 한정한다. DOI 매칭 전에 `<ReferenceList>`를 제거한다.

**X-3. OpenAlex 간격 제한이 동시 호출자 사이에서 지켜지지 않는다** — 확인(코드), 429는 유력
- 위치: `src/service/providers/openalex.ts:112, 135-155`, `src/service/search/openalex-semantic-search.ts:14-16, 63-83`
- 현상: `request()`가 `lastRequest`를 읽고, 자고, 설정하는데 큐가 없어 두 호출자가 같은 지연을 계산하고 함께 발사한다. 채팅 경로의 의미 검색은 별도의 제한기를 쓴다.
- 해결: 한 모듈이 소유하는 Promise 체인 제한기 하나를 두 경로가 함께 쓴다(`linked-discoveries.ts:37-38` 방식).

**X-4. 탐색이 OpenAlex의 429 재설정 정보를 무시하고, 재시도에 백오프가 없다** — 확인
- 위치: `src/service/providers/openalex.ts:163-190, 201`, `src/service/discovery/engine.ts:497-498`
- 현상: Retry-After가 2초여도 실행을 60초 멈추고 수동 재개를 요구한다. 일일 예산 정지는 즉시 재개할 수 있어 다시 실패한다. 네트워크 오류와 5xx는 150ms 간격으로 바로 재시도하며 매번 `onCall()`로 40회 예산을 쓴다.
- 해결: Retry-After가 5초 이하면 `request()` 안에서 자고 재시도한다. 그 밖에는 두 코드 모두 `run.retryAt = now + resetMs`를 설정한다. 지터가 있는 지수 백오프를 넣고 논리적 요청당 `onCall`을 한 번만 센다.

**X-5. JSON이 아니거나 타임아웃된 응답 본문이 원시 오류로 새어 나온다** — 확인(유발은 드묾)
- 위치: `openalex.ts:208`, `ollama-local.ts:36, 68`, `ollama.ts:51`, `doi-org.ts:73`, `pubmed-search.ts:155, 228`
- 해결: 본문 파싱을 재시도 루프 안으로 옮기고 실패를 `AppError("NETWORK"/"PROVIDER_SCHEMA")`로 바꾼다. CSL에 zod 가드를 넣는다.

**X-6. AI 실행에서 "더 보기"·재개 시 AI 순위가 덮어써진다** — 유력
- 위치: `src/service/providers/openai.ts:399-414`, `src/service/discovery/engine.ts:157-186, 470-480, 649-653`
- 현상: `evaluate()`가 추천 후보에 `100-i` 순위를 주지만, 이후 `execute()`의 `rank()`가 모든 순위를 내용 점수(최대 약 1.2)로 다시 쓴다.
- 해결: `rank()`에서 `evidence.ai`가 있는 항목의 순위 오프셋을 유지하거나 AI 실행에서 "더 보기"를 막는다.

**X-7. AI 호출·입력 예약이 실패해도 반환되지 않는다** — 확인
- 위치: `src/service/providers/openai.ts:130-167`
- 현상: Ollama나 Codex가 내려가 있을 때 세 번 재개하면 응답을 한 번도 받지 못하고 "AI 호출 상한 3회"로 실행이 영구히 막힌다.
- 해결: 응답 전에 실패한 요청은 예약을 반환한다(과금될 수 있는 OpenAI 중단은 유지).

**X-8. 한쪽 출처에 PMID가 없으면 학술 검색 병합에 중복이 남는다** — 확인(영향 낮음)
- 위치: `src/service/search/scholarly-search.ts:6-10, 32-47`
- 해결: 각 결과를 모든 식별자로 색인하고 어느 하나라도 맞으면 합친다.

### 2.7 계보 리포트 · AI 연동 (G)

**G-1. 공급자 장애가 모든 카드를 "failed"로 만들고 카드 단계는 완료 처리된다** — 확인
- 위치: `src/service/genealogy/engine.ts:552-576, 1117-1118, 218`, `src/service/genealogy/llm.ts:83-91`
- 현상: 워커가 abort와 BUDGET을 뺀 모든 오류를 잡아 `cardStatus = "failed"`로 두고 넘어간다. Claude·Codex 로그아웃, CLI 없음, 네트워크 단절이면 논문마다 호출 하나를 태우고 전부 실패 처리되며, 자동 모드는 카드 없이 gaps·outline으로 간다. "계속"은 첫 미완료 단계부터 시작하므로 카드를 다시 만들지 않고, `ensureCorpus`는 `none`과 `stale`만 재시도한다.
- 해결: 논문별 오류(NO_TEXT, AI_FORMAT, AI_REFUSAL, AI_INPUT)만 논문 실패로 처리한다. `AI_PROVIDER`·`*_UNAVAILABLE`이거나 연속 3회 실패면 Pause를 던지고 논문은 `none`으로 둔다. 일시적 실패가 남아 있으면 `completed.cards`를 세우지 않는다.

**G-2. Ollama 429가 할당량 정지로 처리되지 않는다** — 확인
- 위치: `src/service/genealogy/llm.ts:84, 87`, `src/service/providers/ollama.ts:28-30`
- 해결: 오류에 HTTP 상태를 싣고 `raw()`에서 429를 BUDGET으로 바꾼다. 5xx는 재시도한다.

**G-3. 목차 편집, 논문 유형 변경, prepare 재실행이 뒤 단계를 무효화하지 않는다** — 확인
- 위치: `src/service/genealogy/engine.ts:1023-1032, 159-170, 531-533, 175, 1398`
- 현상: `editOutline`이 목차를 다시 쓰지만(바뀐 절의 새 uid, 이름이 바뀐 장의 새 파일 이름) `invalidate(g, "write")`를 부르지 않는다. 완성된 리포트에서 목차를 고치고 "계속"을 누르면 바로 렌더로 간다. `assembleFiles`는 존재하는 장 파일만 읽으므로 이름이 바뀐 장이 사라지고, 고친 절은 옛 본문으로 렌더된다. check는 "completed"라 건너뛰어 경고도 없다.
- 해결: 절이나 파일이 바뀌면 `editOutline`에서 `invalidate(g, "write")`를 부른다. 카드가 stale이 되면 "cards"를 무효화한다. `assembleFiles`는 장 파일이 없으면 실패하거나 경고한다.

**G-4. 일시적 공급자 오류에 재시도가 없어 한 번의 장애가 긴 실행을 끝낸다** — 확인(빈도는 공급자에 달림)
- 위치: `src/service/genealogy/llm.ts:94-112`, `src/service/codex/client.ts:373-379`, `src/service/providers/ollama.ts:43`
- 현상: Codex 유휴 정지, Ollama 스트림 절단, 16k 토큰 절에서의 240초 타임아웃이 `AI_PROVIDER`가 되어 밤새 돌던 자동 실행이 그 절에서 멈춘다.
- 해결: `GenealogyAI.raw`에서 `AI_PROVIDER`를 백오프와 함께 한두 번 재시도한다(BUDGET과 AI_REFUSAL은 제외). Ollama 타임아웃을 총 시간이 아닌 유휴 타임아웃으로 바꾼다.

**G-5. 첫 응답이 유효한 JSON이 아니면 엄격/관대 파싱 전환이 깨진다** — 확인
- 위치: `src/service/genealogy/engine.ts:1006, 1219`, `src/service/genealogy/llm.ts:97-102`
- 현상: `attempt++ === 0`이 parse 안에 있는데 parse는 `JSON.parse`가 성공할 때만 불린다. 첫 응답이 잘린 JSON이면 카운터가 0에 머물러, 관대하게 받아야 할 두 번째 응답이 엄격 모드로 판정되어 `AI_FORMAT`이 난다.
- 해결: `json()`이 시도 인덱스를 parse에 넘긴다.

**G-6. 쓰기 루프가 장 중간에 빠지면 장 파일이 쓰이지 않는다** — 확인
- 위치: `src/service/genealogy/engine.ts:1190-1252`
- 현상: 2.1과 2.2는 DB에 저장되었는데 2.3에서 할당량 정지·취소·오류가 나면 디스크의 장 파일은 없거나 옛 내용이다. 일시정지 중에도 Check와 Render 버튼은 켜져 있어, 목차는 "작성됨"이라는데 렌더 결과에는 그 절이 빠지거나 다르게 나온다.
- 해결: 장별 루프를 try/finally로 감싸 `changed`면 `writeChapter`를 부른다. 또는 `assembleFiles`가 `sectionTexts`에서 장을 만든다.

**G-7. 큰 말뭉치에서 목차·원장 호출에 크기 전략이 없다** — 유력
- 위치: `src/service/genealogy/engine.ts:981-1004`, `src/service/genealogy/outline.ts:91-106`, `src/service/genealogy/llm.ts:19-20`
- 현상: 두 호출 모두 모든 논문의 요약과 전체 인용 간선 목록을 보낸다(유일한 방어는 바이트 기준 900KB). 수백 편에서 컨텍스트 창을 넘으면 재개할 때마다 똑같이 실패해 리포트가 목차를 넘어가지 못한다.
- 해결: 경로별로 토큰을 추정하고, 예산을 넘으면 요약을 줄이거나 원장을 군집별로 만들어 합친다. `allowedKeys`는 그 장의 키와 절의 키로 제한한다.

**G-8. 후보 조회 한 건의 실패가 gaps·write 단계 전체를 중단시킨다** — 확인
- 위치: `src/service/genealogy/engine.ts:876-885, 673, 1074, 1346`
- 현상: OpenAlex의 순간 장애 하나로 단계가 실패한다. `write()`에서는 요청이 이미 해결됨으로 표시된 뒤라, 재개해도 그 후보는 자동 채택되지 않는다.
- 해결: 선택 항목별로 잡아 건너뛰고 보고한다. 채택을 시도한 뒤에만 요청을 해결됨으로 표시한다.

**G-9. `fetchPdfs`가 기한 없이 폴링한다** — 유력
- 위치: `src/service/genealogy/engine.ts:471-480`
- 해결: 전체 또는 무진행 기한(예: 수가 변하지 않은 채 10분)을 두고, 넘으면 다운로드 실행을 취소한 뒤 계속한다.

**G-10. 실행 중인 작업이 오래된 Genealogy 객체를 들고 동시 편집을 덮어쓴다** — 확인(현재는 UI가 버튼을 막고 있음)
- 위치: `src/service/genealogy/engine.ts:202-210, 144-151, 1034-1040, 1375-1381`
- 해결: `active.has(id)`일 때 update·approve·setType·rewrite를 거부한다. 또는 `progress()`가 job 필드만 갱신하게 한다.

**G-11. `maxCalls`가 리포트가 아니라 실행 단위이고, 안내 문구는 그렇게 말하지 않는다** — 확인
- 위치: `src/service/genealogy/engine.ts:211`, `src/service/genealogy/llm.ts:21-22`
- 현상: "AI 호출 상한 600회에 도달… 상한을 늘린 뒤 재개하세요" 뒤에 그냥 계속을 누르면 새 600회를 받는다. 리포트의 총 지출을 제한하지 못한다.
- 해결: 누적 호출 수를 리포트에 저장하거나 문구를 고친다.

**G-12. Claude 턴이 답을 다 받은 뒤 프로세스가 비정상 종료되면 답을 버린다** — 유력
- 위치: `src/service/claude/client.ts:229, 259-267`, `src/service/claude/process.ts:105-106, 124`
- 해결: `completed`가 세워지면 바로 읽기 루프를 빠져나와 프로세스를 멈춘다.

**G-13. 작업 폴더 쓰기가 원자적이지 않고 해시가 파일 뒤에 저장된다** — 확인(기전), 확률 낮음
- 위치: `src/service/genealogy/engine.ts:959-965, 1408-1417, 621`
- 현상: 쓰기와 해시 갱신 사이에 충돌이 나면 앱 자신의 파일이 사용자가 고친 것처럼 보인다. `00_contents.md`가 잘리면 다음 쓰기가 그것을 사용자의 목차로 다시 파싱해 장을 빼고, `pruneChapters`가 그 파일을 지운다.
- 해결: 임시 파일에 쓰고 rename한다. 해시는 같은 단계에서 또는 rename 전에 저장한다.

**G-14. 외부 도구에 SIGTERM만 보내고 프로세스 환경 전체를 넘긴다** — 확인(환경), 추정(멈춤)
- 위치: `src/service/genealogy/render.ts:16-38`
- 현상: `env: {...process.env}`로 서비스 환경의 API 키가 pandoc·typst에 전달된다(Codex와 Claude는 허용 목록 환경을 쓴다).
- 해결: 최소 환경을 넘긴다. 1~2초 뒤 SIGKILL로 올리고 프로세스 그룹을 죽일 수 있게 분리해 띄운다.

**G-15. 논문 본문이 라이브러리 변경을 유도할 수 있다** — 유력(영향 낮음)
- 위치: `src/service/genealogy/engine.ts:1272-1349, 1070-1075`, `src/service/chat/service.ts:102-114`
- 현상: PDF에 심은 지시문이 작성 모델로 하여금 임의의 논문을 "요청"하게 할 수 있고, 자동 모드에서는 관련도 0.8 이상으로 고정되어 판정 없이 컬렉션에 추가·다운로드된다. 증가 상한과 `perRound`로 제한되기는 한다.
- 해결: 작성 모델의 요청도 판정을 거치게 한다. 요청으로 인한 채택에는 사용자 확인이나 별도 상한을 둔다.

**G-16. 작은 누수** — 확인
- `engine.ts:410-415`: 재시도 뒤 키 하나가 빠지면 prepare 전체가 실패한다. 서지의 유형이나 "O"로 대체한다.
- `outline.ts:245-248`, `store.ts:195-204`: uid가 바뀌어도 `text:<uid>` 행이 지워지지 않고 매 쓰기마다 전부 읽힌다.
- `claude/client.ts:206, 291`: 턴 중에 서비스가 죽으면 `request-*` 폴더가 남는다. 시작 시 청소한다.
- `codex/transport.ts:335-338`, `claude/process.ts:116-117`: SIGKILL 대체 타이머가 `unref`되어 있어, 종료 시 SIGTERM을 무시하는 자식이 살아남는다.

### 2.8 렌더러 (R)

**R-1. 계보 리포트 화면에서 Cmd+S / Cmd+A / Cmd+E가 숨은 목록에 작용한다** — 확인★
- 위치: `src/renderer/App.tsx:930-965`
- 현상: 전역 keydown 핸들러는 편집 가능한 대상, `dialog`, `readerActive`에서만 빠진다. 계보 작업 공간은 어느 것도 아니다. 아래 목록에 선택이 남은 채 리포트를 열고 Cmd+S를 누르면 보이지 않는 선택이 아카이브된다.
- 해결: `genealogyId`가 있을 때(그리고 시작 화면에서)도 빠진다. 더 좋게는 목록·그래프 작업 공간이 렌더될 때만 단축키를 등록한다.

**R-2. 편집 중이던 논문이 사라지면 "서지정보 수정"이 "새 논문 등록"으로 바뀐다** — 확인(기전), 유발은 드묾
- 위치: `src/renderer/App.tsx:2614-2626`, `src/renderer/components/Dialogs.tsx:347-351`
- 현상: `WorkEditor`는 제출 시점에 `work ? editWork : manualWork`를 정한다. 편집 중에 배경의 `changed`가 목록을 다시 읽어 그 논문이 빠지면 `inspected`가 null이 되고, 저장은 중복 수동 문헌을 만든다.
- 해결: 대화상자가 열릴 때 편집 대상을 상태에 고정하고 명시적인 mode prop을 넘긴다.

**R-3. 논문이 현재 목록에서 빠지면 PDF 리더가 읽는 도중에 닫힌다** — 유력
- 위치: `src/renderer/App.tsx:212, 394-399, 666-672`, `src/shared/navigation.ts:128-136`
- 현상: 검토 대기함에서 원문 보기를 열고 오른쪽 창에서 "아카이브에 저장"을 누르면, 목록 재조회가 인스펙터를 떨어뜨려 리더가 사라진다. 핵심 문헌에서 별표를 풀거나 읽기 필터 아래에서 읽기 상태를 바꿀 때도 같다.
- 해결: 리더가 그 논문을 보여주는 동안은 앵커를 떨어뜨리지 않는다(`openArticle`에서 `listed: false`). 또는 리더 표시를 `inspectorId`와 독립적으로 `reader.work.id`에 건다.

**R-4. 메모 자동 저장이 잠깐 옛 메모를 보여주고, 캐럿이 튀고, 입력을 잃을 수 있다** — 유력
- 위치: `src/renderer/App.tsx:511-545, 2441-2459`, `src/renderer/components/Inspector.tsx:614-621`
- 현상: 저장 성공 시 초안은 지워지지만 `inspected`는 이후의 inspect 왕복에서야 갱신된다. 그 사이 textarea가 저장 전 메모로 돌아가 캐럿이 끝으로 튀고, 그 창에서 친 글자는 옛 텍스트에서 새 초안을 시작해 방금 저장한 내용을 덮는다. 종료 시 초안을 내보내지 않아 마지막 650ms의 입력이 사라진다.
- 해결: `inspected.state.note === draft.text`가 될 때까지 초안을 유지하거나, 저장 성공 시 `inspected.state.note`를 직접 갱신한다. beforeunload/visibilitychange에서 대기 중인 초안을 내보낸다.

**R-5. 새 노드 하나가 손으로 배치한 것을 포함해 그래프 레이아웃 전체를 버린다** — 확인★
- 위치: `src/renderer/components/Graph.tsx:747-764`, `src/renderer/components/graphLayout.ts:84-91, 98-123`
- 현상: `placeGraph`는 그려진 모든 문헌에 저장 위치가 있을 때만 복원하고, 아니면 `forceLayout`이 모든 노드를 d3 기본 나선에서 다시 시뮬레이션해 저장 위치를 덮어쓴다. 논문 한 편을 저장하거나 탐색이 후보 하나를 추가하면 수동 배치가 사라진다. 그래프 보기에서 탐색이 도는 동안에는 `changed`마다 반복되며 매번 메인 스레드를 막는다(1,000노드에서 약 1초).
- 해결: 시뮬레이션 시작점을 현재·저장 위치로 잡고, 위치가 있는 노드는 `fx`/`fy`로 고정하고, 새 노드만 몇 틱 시뮬레이션한다. 그래프가 비어 있었던 경우가 아니면 뷰포트를 다시 맞추지 않는다.

**R-6. 배경 새로고침이 고정한 군집을 풀고 호버 미리보기를 끝내며 Louvain을 다시 돌린다** — 확인
- 위치: `src/renderer/App.tsx:394-395, 566-569`, `src/renderer/components/Graph.tsx:229-234, 294-304, 691, 820-823`
- 현상: 목록 재조회가 매번 새 배열을 저장하므로 아무것도 안 바뀌어도 `works → display → membership`이 새 참조가 된다. 군집을 고정한 뒤 별표를 주거나 메모를 고치면 고정이 풀린다.
- 해결: 값싼 서명(id, 연도, screening, 주제, 간선 수)이 같으면 `show()`에서 이전 참조를 유지하거나 Graph의 memo를 그 서명에 건다. 군집 id 집합이 실제로 다를 때만 고정을 푼다.

**R-7. SeedDialog가 선택한 논문마다 inspect RPC를 보내고, 하나가 실패하면 모든 제목이 비워진다** — 확인
- 위치: `src/renderer/components/Dialogs.tsx:444-454`
- 현상: 3,000편 목록에서 "모두 선택" 뒤 seed를 열면 동시 RPC 3,000개가 나가고, 오래된 id 하나로 `Promise.all` 전체가 거부된다.
- 해결: 제목을 한 번에 조회하거나 `list.works`의 제목을 재사용한다. `allSettled` 방식으로 바꾸고 렌더 행 수를 제한한다.

**R-8. 계보 목차 편집기가 저장 성공 전에 초안을 버린다** — 확인★
- 위치: `src/renderer/components/GenealogyWorkspace.tsx:302, 709`
- 현상: `onSave(draft); setDraft(null)`. 서비스가 거부하면(파싱 오류, 작업 실행 중) 토스트만 뜨고 편집기는 닫혀 글이 사라진다.
- 해결: `onSave`가 Promise를 돌려주고 resolve될 때만 편집기를 닫는다. 대기 중에는 버튼을 비활성화한다.

**R-9. 목차가 생기기 전에 연 본문 탭이 첫 장을 불러오지 않는다** — 확인
- 위치: `src/renderer/components/GenealogyWorkspace.tsx:400-413, 421`
- 해결: 유효 파일을 파생시켜(`chapters.find(c => c.file === file) ?? chapters[0]`) 그것으로 불러오고, 바뀔 때 `text`를 비운다.

**R-10. 계보 원고 Markdown이 LLM이 쓴 텍스트의 링크와 이미지 태그를 그대로 렌더한다** — 정정됨(위험은 과장이었음)
- 위치: `src/renderer/components/GenealogyWorkspace.tsx:466`
- 현상: `![](https://…)`가 실제 `<img>` 요소가 된다.
- **정정 (2026-11-18 QA)**: 처음에는 "CSP가 없어 렌더 즉시 원격 이미지를 요청한다"고 적었으나 틀렸다. `index.html`에는 이미 `img-src 'self' data: blob:`인 CSP가 있어 원격 이미지는 요청되지 않는다. 남는 문제는 깨진 이미지 아이콘과 눌러도 동작하지 않는 링크 정도였다.
- 조치: `AISidebar.tsx`와 같은 오버라이드(`a` → span, `img` → alt 텍스트)를 적용했다. CSP는 바꿀 필요가 없다.

**R-11. 인스펙터 "서고 서지 확인"이 한 파일의 후보를 다른 파일에 적용할 수 있다** — 확인★
- 위치: `src/renderer/components/Inspector.tsx:133-140`
- 현상: `shelfResolve(...).then(setShelfFile)`에 패널이 아직 같은 파일을 보는지 확인이 없다. 조회를 누르고 다른 서고 논문으로 넘어가면 늦은 응답이 이전 파일의 후보로 덮어쓰고, "이 서지 사용"이 그 후보를 새 `shelfFileId`와 함께 보내 잘못된 서지가 붙는다.
- 해결: 호출 시점의 `fileId`를 잡아 두고 `shelfFileId`가 바뀌었으면 결과를 무시한다.

**R-12. 인스펙터 태그 필드가 오래된 사본을 가지고 blur에서 되써버린다** — 확인
- 위치: `src/renderer/components/Inspector.tsx:145-156, 594-606`
- 현상: 일괄 편집이나 되돌리기로 태그가 바뀐 뒤 태그 필드를 눌렀다 나오면 옛 값이 조용히 되돌려진다.
- 해결: 재설정 의존성에 `work?.state.tags.join(",")`를 넣거나, 사용자가 실제로 입력했을 때만 패치한다.

**R-13. 텍스트 선택 드래그가 배경에서 끝나면 모달이 닫혀 입력을 잃는다** — 유력(WebKit 동작에 달림)
- 위치: `src/renderer/components/Modal.tsx:28-30`
- 해결: pointerdown 대상을 기록해 pointerdown과 click이 모두 dialog 요소에서 일어났을 때만 닫는다.

**R-14. 낮은 심각도** — 확인
- `App.tsx:400-409`, `Filters.tsx:110-121`: 포함어·제외어가 키 입력마다 적용되어, 아무것도 맞지 않는 오타가 선택을 지우고 오타를 고쳐도 돌아오지 않는다. Enter/blur에서 확정한다.
- `App.tsx:917-929`: Shift 범위 선택의 `lastIndex`가 정렬·페이지·검색어 변경에서 재설정되지 않아 엉뚱한 범위가 선택된다. id로 앵커를 잡는다.
- `ImportResults.tsx:20-27`: 가져오기 중 열어 둔 결과가 진행 틱마다 접힌다.
- `Inspector.tsx:157-170`: seedId마다 inspect를 보내고 유효성 플래그가 없어, 느린 응답이 현재 논문의 제목 맵을 덮는다.
- `App.tsx:2567-2584`: 토스트 포털 대상을 렌더 중에 읽어, 닫히는 대화상자 안이나 최상위 레이어 아래에 뜰 수 있다.
- `HelpTooltip.tsx:184-212`: React가 소유한 요소의 `title`을 지웠다가 캡처한 옛 값으로 되돌린다.
- `App.tsx:728-738`: `restoreSelected`가 RPC 완료 전에 상태를 지워, 실패하면 선택이 이미 사라져 있다.
- `App.tsx:234-236, 2441-2458`: 메모 초안이 문헌 id만으로 키가 잡혀, 프로젝트 A의 초안이 프로젝트 B의 같은 논문에 보인다.
- `Graph.tsx:327-339, 928`: 그래프 검색 커서가 재설정되지 않아 "5/3"으로 표시될 수 있다.
- 설계 질문(버그로 단정하지 않음): 그래프에서 노드를 눌러 살펴보면 선택도 함께 토글된다. 목록에서는 행 클릭이 살펴보기만 한다.

---

## 3. 효율 개선

### 3.1 횡단 항목 (효과가 큰 순서)

**E-1. 읽기 전용 명령이 `changed`를 내보내 앱 전체를 새로고침한다** — 확인★
- 위치: `src/main/index.ts:279-307`(수동 제외 목록), 소비처 `App.tsx:336-350`, `AISidebar.tsx:73`, `ShelfSettings.tsx:94-98`
- 현상: 목록에 없는 모든 명령이 `changed` → snapshot + list + inspect + chatSession을 유발한다. 아무것도 바꾸지 않는데 목록에서 빠진 것: `passageSearch`, `passageAsk`, `passageAskCancel`, `passageStatus`, `importItems`, `previewTrashDeletion`, `previewBib`, `codexStatus`, `codexModels`, `testConnection`, `seedQueries`, `openExternal`, `attachmentAction`(열기·보기), `choose*`, null을 돌려주는 취소된 대화상자. `CodexConnection.tsx:48-65`는 로그인 중 2.5초마다 `codexStatus`를 폴링하므로 설정 창 뒤에서 앱 전체가 2.5초마다 다시 읽는다.
- 해결: 뒤집는다. `contracts.ts`의 명령마다 `mutates` 플래그를 두고 그것에만 내보낸다. `choose*`가 null을 돌려줄 때는 내보내지 않는다. 더 나아가 데이터가 실제로 바뀌는 서비스 쪽에서 내보낸다.
- 효과: 구절 검색·답변·상태 폴링·가져오기 결과 보기마다 일어나던 snapshot과 list 질의가 사라진다. 아래 여러 항목(R-2, R-3, R-6의 유발 빈도 포함)도 함께 줄어든다.

**E-2. `list()`가 페이지마다 범위 전체를 읽고 JSON 파싱한다** — 확인
- 위치: `src/service/db/database.ts:928-1068`, `counts()` `1095-1116`
- 현상: 스크롤 페이지를 포함한 모든 목록 요청이 범위의 모든 문헌을 `views()`로 읽는다(추가 질의 5개, `raw`와 `references`를 포함한 전체 `works.data`). 관심도 캐시 키를 위해 모든 제목·초록을 해시하고 JS에서 거르고 정렬한 뒤 `limit`만큼 자른다. `counts()`는 snapshot마다 프로젝트의 모든 state JSON을 파싱한다.
- 해결: 파싱된 범위를 (project, scope, scopeId, revision)으로 캐시한다. 또는 자주 쓰는 열(title, year, citations, screening)을 생성 열·실제 열로 두고 SQL에서 페이징한다. `counts()`는 `GROUP BY json_extract(state,'$.screening')` 질의 하나로 계산한다.
- 효과: 목록 페이징과 snapshot 비용이 서고 크기와 무관해진다.

**E-3. `prepare()`가 약 390곳에서, 루프 안에서도 쓰인다** — 확인★(속도 향상은 미측정)
- 위치: `src/service/db/sqlite.ts`(래퍼), 핫 루프 `database.ts:341-369, 499, 708-730`, `merge.ts:70-116`, `trash.ts:92-113`, `service.ts:325-327`, `shelf/indexer.ts:520-549`
- 현상: `bun:sqlite`에서 `db.prepare`는 호출마다 새로 컴파일하고 `db.query`만 캐시한다. 참고문헌 200개인 문헌 하나가 citations 삽입문을 200번 컴파일한다.
- 해결: `sqlite.ts`의 래퍼에서 `prepare`를 `query`에 위임하도록 오버라이드한다. **한 파일의 몇 줄로 전 영역에 적용된다.** 바꾸기 전에 `prepare`로 만든 문장을 `finalize()`하는 곳이 있는지 확인한다(캐시된 문장을 finalize하면 안 된다).

**E-4. 그래프 요청이 새로고침마다 모든 노드의 전체 Work 레코드를 보낸다** — 확인
- 위치: `src/service/db/database.ts:405-415, 1021-1050`, `src/renderer/App.tsx:417-427`
- 현상: 1,000개 넘는 WorkView가 초록, `references[]`, `related[]`, `raw`, `originalBib`와 함께 WKWebView 브리지로 직렬화되고 `revision`이 오를 때마다 다시 전송된다.
- 해결: 얇은 그래프 노드 DTO(id, 제목, 앞 저자, 연도, 게재지, 인용 수, screening, 주제, 서고 폴더, citekey). 유사도 간선은 서버에서 계산해 링크로 보낸다. 범위 서명을 두어 바뀐 것이 없으면 재조회를 건너뛴다.
- 효과: 그래프 새로고침당 JSON이 한 자릿수 배 이상 줄 것으로 본다(미측정).

**E-5. snapshot이 무겁고 폴링된다** — 확인
- 위치: `src/renderer/App.tsx:351-388`, `src/service/service.ts:273-292`, `src/service/fulltext/jobs.ts:189-223`
- 현상: 작업이 도는 동안 2초마다, 그리고 진행·서고·계보 이벤트마다(250ms 스로틀) 요청된다. 응답에는 `ui`(최대 약 850KB의 탐색 기록 전체, 시작 때만 쓰임), 항목 배열이 딸린 실행 최대 100개, 서고 폴더 트리 전체가 들어간다. 게다가 매 호출이 `downloads.syncHistory()`를 await하는데, 이는 모든 다운로드 실행을 파싱하고 미해결 항목마다 파일 stat(경우에 따라 전체 SHA-256)을 한다. 오프라인 SMB 서고에서는 UI 전체가 기대는 snapshot이 멈출 수 있다.
- 해결: `ui`는 요청할 때만(프로젝트당 첫 로드) 보낸다. 폴링과 진행용으로 가벼운 상태 명령(활성 실행, 분류 작업, 서고 작업, 수)을 추가한다. `syncHistory`는 타이머나 다운로드·가져오기 완료 뒤에 돌리고 snapshot에서 await하지 않는다. `usageSummary`의 GROUP BY도 캐시한다(`service.ts:244-262`).

**E-6. PDF 추출마다 Bun 프로세스를 하나씩 띄우고 파일을 2~3번 통째로 읽는다** — 확인(구조), 시간은 추정
- 위치: `src/workers/pdf.ts:5-18`, `src/service/interchange/pdf.ts:93-178`, `hashFile`(64KB 청크)
- 현상: 서지·서고·전문·구절 추출마다 새 런타임을 fork하고 pdfjs를 동적 import하며 파일 전체를 메모리에 올린다. 두 쪽만 읽는 서지 모드도 SMB에서 파일 전체를 가져온다.
- 해결: `{ path, mode }` 요청을 받는 소규모 상주 워커 풀을 두고, 멈춤 격리를 위해 N개 문서마다 또는 타임아웃 시 재활용한다. 서지·서고 모드에는 pdfjs에 범위 리더를 넘긴다. `highWaterMark`를 1~4MB로 올린다.
- 효과: PDF당 약 100~300ms의 시작 비용 제거(추정), 첫 색인 시 NAS 트래픽 약 절반.

**E-7. 앱 내 PDF 로딩이 왕복이 많은 이중 JSON 파이프라인이다** — 확인
- 위치: `src/renderer/components/ArticleReader.tsx:281-293`, `src/service/interchange/pdf-reader.ts:33-59`, `src/renderer/bridge.ts:17-21`
- 현상: `pdfInfo`가 파일 전체를 해시하고(채팅 컨텍스트에서는 두 번 더), 512KB 청크마다 RPC 하나가 구성원 질의를 다시 돌리고 파일을 다시 열고 base64·JSON을 거쳐 웹뷰에서 JS 소스로 평가된다. 렌더러는 `Uint8Array.from(atob(...), c => …)`로 청크당 약 70만 번 콜백을 돈다. 50MB PDF에 왕복 약 100회.
- 해결: 검증된 첨부를 커스텀 스킴이나 `views://` 핸들러(또는 일회용 토큰의 localhost 스트림)로 제공해 ArrayBuffer로 `fetch()`한다. 최소한 청크를 4~8MB로 올리고, (attachmentId, hash)별로 검증 결과와 파일 디스크립터를 캐시하고, `info()`에서 `shelfFileUnchanged` 지름길을 쓴다. `pdf.ts:50-52`의 주석상 열 때의 전체 검증은 의도된 절충이므로, 서고 파일에 한해 크기·mtime 지름길을 적용하는 선에서 재검토한다.

**E-8. 시작이 직렬이고 창이 마지막에 뜬다** — 확인
- 위치: `src/main/index.ts:355-405`, `src/shared/refresh-queue.ts:20`
- 현상: Keychain 헬퍼(경우에 따라 두 번) → 서비스 fork와 `ready`(최대 20초) → init → 메뉴 → 창. `refreshQueue`는 trailing-edge 전용이라 첫 snapshot이 250ms를 기다린다.
- 해결: 창을 즉시 만들고 서비스 fork를 Keychain 읽기와 병렬로 한다. `refreshQueue`에 leading edge를 준다(한가하면 즉시 실행, 실행 중에만 합침).
- 효과: 창이 수백 ms~수 초 일찍 뜬다. M-1의 "앱이 실행되지 않은 것처럼 보임"도 해소된다.

### 3.2 데이터베이스

**E-9. 색인과 반복 질의** — 확인
- `interchange/pdf.ts:257-261`, `shelf/indexer.ts:623, 834`: 해시로 첨부를 찾는 것이 JSON 추출이 딸린 전체 스캔이다. `CREATE INDEX idx_attachments_hash ON attachments(json_extract(data,'$.hash'))`를 추가한다.
- `database.ts:164-168, 209-215`: `project(id)`가 모든 프로젝트를, `collections(projectId)`가 모든 컬렉션의 수를 계산해 id 하나의 존재만 확인한다. 단일 행 존재 질의로 바꾸고 `project_works(project_id, json_extract(state,'$.screening'))` 표현식 색인을 추가한다.
- `passages/store.ts:178-184`: `count(*) FROM vectors WHERE model=?`에 `model` 색인이 없어 blob 테이블을 훑는다. `vectors(model)` 색인을 추가한다.
- `interchange/pdf.ts:274-278`: 폴더 매칭이 PDF마다 아카이브 전체를 다시 읽고 파싱한다. 실행당 한 번만 읽는다.

**E-10. `metadata_snapshots`가 한없이 커진다** — 확인
- 위치: `src/service/db/database.ts:356-364`
- 현상: 같은 논문을 다시 발견할 때마다 원시 공급자 페이로드가 든 전체 사본이 추가된다. `match()`는 가장 최근 행만 읽는다.
- 해결: (문헌, 출처)당 첫 번째와 최신 스냅샷만 유지하거나 페이로드 해시가 같으면 삽입을 건너뛴다.
- 효과: DB·백업·병합 스냅샷(D-9)의 비대화를 멈춘다.

**E-11. 기타 DB** — 확인
- `interchange/bibtex.ts:64-80, 129`: `parseBib`가 항목마다 모든 `@string`/`@preamble`을 다시 파싱하고 모든 문헌에 저장한다. 매크로를 한 번만 파싱하고 실제로 참조된 것만 붙인다.
- `db/trash.ts:76-91, 115-173`, `db/projects.ts:6-21`: 휴지통 비우기와 프로젝트 삭제가 DB의 모든 실행과 모든 후보 evidence JSON을 파싱한다. `json_each`로 SQL에서 제한한다.
- `database.ts:1070-1079`, `pdf-export.ts:167-190`: `attachments()`가 서비스 스레드에서 행마다 `existsSync`를 부른다. 느린 마운트가 모든 RPC를 막는다. 저장된 행을 돌려주고 `exists`는 필요한 곳에서 비동기로 계산한다.
- `interchange/backup.ts:97-103`: 백업이 첨부마다 세 번 읽는다(원본 해시, 복사, 사본 해시). 해시를 통과시키며 한 번에 복사하고 3~4개를 동시에 처리한다. M-2도 완화된다.

### 3.3 서고 · 구절

**E-12.** — 확인
- `shelf/indexer.ts:520-549`: `applyScan`이 30분마다 약 8,000개 파일 각각에 SELECT, JSON.parse, UPDATE를 하나의 동기 트랜잭션에서 한다. 크기·mtime이 다르거나 상태가 `missing`인 행만 갱신한다. 한가한 스캔이 약 16,000문장에서 거의 0으로 준다.
- `shelf/indexer.ts:1262-1283`: `embed()`가 매 주기 모든 서고 문헌을 다시 읽고 다시 해시한다. 모델 키·프롬프트 버전·"문헌 변경" 카운터가 같으면 건너뛰거나, 입력 해시를 쓰기 시점에 행에 저장해 SQL로 불일치만 고른다.
- `shelf/resolver.ts:133-154`, `indexer.ts:608-611`: 제목 조회가 한 번에 하나씩 돌고 `processChunk` 안에서 불려 다음 청크의 해시·추출이 기다린다. 속도 제한 안에서 3~4개를 동시에 돌리거나 해석을 별도 단계로 뺀다.
- `passages/indexer.ts:121-135, 213-220, 261`: `status()`가 `counts`를 두 번, `sources()`, `docs()`를 부르고, `pending(model, 0, …)`가 임베딩된 모든 구절을 훑는다. "id까지 임베딩 완료" 워터마크를 `meta`에 두고 `sources`/`docs`/`counts`를 서고 revision으로 캐시한다.
- `passages/search.ts:147, 73-74`, `shelf/search.ts:59-64, 72, 91`: 검색이 질의마다 조회 표를 다시 만든다(답변 하나에 `store.docs()` 최대 5회, 질의당 구절 전문 400개 로드). revision으로 캐시하고 필요한 열만 가져온다.
- `shelf/indexer.ts:1038-1044`: `dropWorkIfOrphan`이 파일마다 모든 실행과 seed 프로필을 `instr`로 훑는다. 청크 단위로 id를 모아 기존의 일괄 `dropOrphans`를 쓴다.
- `passages/store.ts:175`: `dropOtherModels`를 부르는 곳이 없어 옛 모델의 벡터가 남는다. 현재 모델에 대기 항목이 없이 패스가 끝나면 지운다.

### 3.4 전문 확보 · 탐색 · AI

**E-13. Codex: 호출마다 새 app-server 프로세스와 설정 왕복 5회, 완전 직렬** — 확인
- 위치: `src/service/codex/client.ts:280-314, 326-337`
- 현상: 전역 큐 때문에 `settings.concurrency`(기본 3)가 Codex에서는 아무 효과가 없어 카드가 한 번에 하나씩 만들어진다. 채팅 답변도 진행 중인 계보 호출 뒤에 줄을 선다.
- 해결: 큐를 2~3짜리 세마포어로 바꾼다(워커는 이미 별도 프로세스). 모델 목록과 할당량 상태를 30~60초 캐시한다. 트랜스포트를 따뜻하게 유지하고 호출마다 새 스레드만 연다.
- 효과: Codex에서 카드 단계가 약 2~3배 빨라지고 수백 번의 호출마다 몇 초를 아낀다(추정).

**E-14. Claude: 요청마다 CLI를 두 번 더 띄운다** — 확인
- 위치: `src/service/claude/client.ts:202-203` (`claude --version`, `claude auth status --json`)
- 해결: 검사 결과를 약 60초 캐시하고 로그인·로그아웃·인증 오류에서 무효화한다. 300편 리포트에서 약 700회의 프로세스 시작이 사라진다.

**E-15. 다운로드 복구와 기록 동기화가 타이머로, 그리고 항목이 끝날 때마다 전체 작업을 다시 한다** — 확인
- 위치: `src/service/fulltext/jobs.ts:66-73, 115, 134, 172-224`, `src/service/fulltext/local-downloads.ts:52-79`
- 현상: 5초마다 모든 다운로드 실행을 파싱하고 미해결 항목마다 `hasValidPdf`를 부른다. `attach()`/`store()`도 논문 하나 받을 때마다 `syncHistory()`를 불러 500편 실행이 전체 기록 패스를 500번 한다. `LocalDownloads` 캐시는 메모리 전용이라 실행할 때마다 `~/Downloads`의 모든 PDF(각 최대 150MB)를 다시 해시·추출한다.
- 해결: fs 감시자나 변화가 없을 때 백오프하는 60초 간격으로 유발한다. SQL에서 실패·대기 항목이 있는 실행만 고른다. `syncHistory`는 `execute` 끝에 한 번만 부른다. 경로·크기·mtime·해시·제목·DOI를 SQLite에 저장한다.
- 효과: 한가할 때의 상시 CPU/IO 부하가 없어지고 F-1의 BUSY 창이 짧아진다.

**E-16. 탐색 엔진** — 확인
- `discovery/engine.ts:438-445, 470, 560-656`: `rank()`가 페이지마다 모든 후보(원시 JSON이 딸린 최대 1,000편)를 읽고 TF-IDF를 다시 계산하며 후보마다 UPDATE를 한다(실행당 최대 40회). 끝과 일시정지 때 한 번만 순위를 매기고, 참고문헌 소속 확인에 Set을 쓴다.
- `discovery/engine.ts:197-207, 259-264, 390-393`: 이미 로컬에 있는 문헌을 OpenAlex에서 다시 가져온다. 배치를 알려진 id(DB에서 바로 후보로 등록)와 없는 id(가져오기)로 나눈다. 40회 예산에서 중요하다.
- `providers/openalex.ts:255`, `discovery/links.ts:19`: 커서 페이징이 50개씩이다. 100으로 올리면 같은 결과에 호출이 절반이다.
- `providers/openalex.ts:88, 208-214, 253-258`: `select=`가 없어 전체 work 객체가 캐시 테이블, `works.raw`, 실행 JSON의 `task.pendingPage`에 세 번 저장된다. 쓰는 필드만 요청하고 `pendingPage`를 실행 JSON 밖에 둔다.
- 부정 캐시가 없다: OpenAlex 404, Crossref 제목 조회, Unpaywall 응답을 캐시하지 않아 실패한 논문의 재시도마다 반복된다. NOT_FOUND는 약 24시간, Crossref/Unpaywall JSON은 약 7일 캐시한다.
- `fulltext/jobs.ts:229-303`: `targets()`와 `preview()`/`missing()`이 문헌마다 직렬로 확인한다. Set으로 검증하고 `existing()`을 8~16 동시성으로 돌린다.
- `openai.ts:399-414`(추천마다 후보 전체 재로딩), `cdp.ts:30`(청크마다 `Buffer.concat`, 큰 메시지에서 제곱 비용), `chrome.ts:98-238`(다운로드만 기다리는 동안에도 매초 DOM 스캔).

**E-17. 계보 리포트와 채팅** — 확인
- `genealogy/engine.ts:679-681, 1088-1089, 515-538, 703-756`: 확장 라운드마다 말뭉치 전체에 대해 작업을 다시 한다(모든 논문의 `readTexts`, 최대 2,500편과 인용 페이지 재조회). `only`를 `readTexts`까지 전달하고 `records` 맵과 인용 페이지를 라운드 사이에 메모리에 둔다. 라운드당 OpenAlex 요청 약 25~60회가 준다(추정).
- `genealogy/engine.ts:202-207, 115-134`, `GenealogyWorkspace.tsx:618-636`: 진행 틱마다 전체 뷰(모든 논문·후보·카드·목차·파일 해시)를 다시 읽는다. 이벤트에 job 패치를 싣고 전체 뷰는 단계 경계에서만 다시 읽는다. 순서 토큰을 넣는다.
- `chat/service.ts:134, 80-84`, `chat/store.ts:47-57`: 스트리밍 중 60ms마다 세션 전체(최대 60메시지)를 직렬화해 SQLite에 쓰고 IPC로 보낸다. 내보내기는 60ms로 두되 저장은 1~2초마다와 끝에 하고, 델타만 보낸다.
- `chat/service.ts:96`, `chat/store.ts:51-53`: 답변마다 추출된 PDF 전문을 다시 저장한다(답변 30개면 사본 30개, 스레드는 삭제되지 않음). 컨텍스트 행을 `attachmentHash`로 키 잡고 메시지에서 참조한다.
- `genealogy/writer.ts:54-70`: 모든 절에서 동일한 `allowedKeys`가 변하는 부분 뒤에 있어 접두 캐싱이 일찍 끊긴다. 안정적인 블록(연구 질문, review, allowedKeys, branches)을 앞에 둔다(공급자의 캐싱 동작에 따라 효과가 달라짐).
- `genealogy/engine.ts:603-605`: 긴 리뷰 논문을 부분별로 직렬 처리하고 부분 결과를 저장하지 않는다. 제한된 동시성으로 돌리고 텍스트 해시와 부분 번호로 캐시한다.

### 3.5 렌더러

**E-18. `App.tsx`가 하나의 덩어리라 상태 변경마다 트리 전체가 다시 렌더된다** — 확인
- 위치: `src/renderer/App.tsx:174-2949`
- 현상: 한 컴포넌트에 약 40개의 `useState`가 있어, 검색어 입력 한 글자·토스트·2초 폴링이 사이드바, 최대 500행, Graph, RightPane을 모두 다시 렌더한다. 어느 것도 memo되어 있지 않고 `inspect`·`toggle`·`openArticle`·`navigate`가 렌더마다 새로 만들어진다. Graph는 호버 위치 갱신마다 `workById`, `visibleTopics`, `years`와 여섯 번의 `display.some`을 다시 계산한다.
- 해결: Sidebar, SearchBar(자기 초안을 소유), SelectionBar, PaperList/PaperRow(`React.memo`), Dialogs 호스트로 분리한다. 콜백을 ref/`useCallback`으로 안정화하고 Graph와 RightPane을 memo한다.

**E-19. 논문 목록이 500행까지 가상화되지 않는다** — 확인
- 위치: `src/renderer/App.tsx:2171-2323, 2379-2409`, `src/renderer/styles.css:1030-1086`
- 해결: 목록을 윈도잉한다. 값싼 첫 단계로 `.paper-row`에 `content-visibility: auto; contain-intrinsic-size: auto 96px`와 memo된 행을 적용하고, `seeds.includes`와 `list.works.some`을 Set으로 바꾼다.

**E-20. 레이아웃과 군집 탐지가 메인 스레드에서 동기적으로, 너무 자주 돈다** — 확인
- 위치: `src/renderer/components/graphLayout.ts:98-123`, `Graph.tsx:294-304, 258-262`
- 해결: R-5와 R-6을 고친 뒤 `forceLayout`(큰 그래프에서는 Louvain도)을 워커에서 돌리거나 틱을 프레임에 나눈다. 구성원을 링크 집합 서명으로 캐시한다.

**E-21. 탐색 상태 저장이 작은 변경마다 기록 전체를 직렬화한다** — 확인
- 위치: `src/renderer/App.tsx:310-320, 481-510`, `src/shared/navigation.ts:171-181, 210-232`, `Graph.tsx:663-666, 759-761`
- 현상: 선택·검색어·필터·위치가 바뀔 때마다 350ms 뒤에 기록 전체를 `JSON.stringify`하고(압축 루프에서 버린 뷰마다 또), 전체를 RPC로 보낸다. `networkPositions`는 커지기만 해서 850KB 상한에 다가가고, 그때 압축이 다른 뷰의 기억된 상태를 조용히 지운다.
- 해결: 뷰별 패치를 저장한다(`saveUi({ viewKey, view })`). 위치를 현재 그려진 id로 가지치기한다.

**E-22. 기타 렌더러** — 확인
- `RightPane.tsx:25-30`, `AISidebar.tsx:24-40, 62-83`: 숨은 AI 사이드바가 살펴보는 논문마다 RPC 3개를 보내고 `changed`마다 다시 읽는다. AI 탭이 활성일 때만 마운트하고 `chat` 이벤트에서만 다시 읽는다.
- `Graph.tsx:620-633, 789-796`: 그래프 박스 선택이 O(N²)다. 선택 이벤트를 `queueMicrotask`/`requestAnimationFrame`으로 합쳐 `onSelection`을 한 번만 부른다.
- `DownloadDialog.tsx:34, 44-66`: 대화상자가 열려 있는 내내 3초마다 선택 id 전체를 보내고 누락 목록 전체를 받는다. 다운로드·매칭 실행이 활성일 때만 폴링한다.

---

## 4. 반복해서 나타난 구조적 원인

개별 수정보다 아래 다섯 가지를 고치면 여러 항목이 함께 해소된다.

1. **"무엇이 바뀌었는가"를 알리는 신호가 너무 거칠다.** 메인의 수동 제외 목록과 단일 `changed` 이벤트가 E-1, E-4, E-5, R-2, R-3, R-6, R-14 일부의 공통 원인이다. 명령에 `mutates` 메타데이터를 두고, 가능하면 서비스가 범위가 붙은 이벤트(`works`, `shelf`, `runs`, `chat`)를 내보내게 한다.
2. **긴 작업이 요청-응답 RPC로 남아 있다.** 백업·복원·PDF 내보내기·서고 편입·정리 적용(M-2)은 탐색·다운로드와 같은 작업 모델(id, 진행 이벤트, 취소, `busy()` 포함)로 옮긴다. 반대로 내부 유지 작업(F-1의 복구 모니터)은 사용자 작업과 같은 `active` 맵을 쓰지 않게 한다.
3. **일시적 실패와 확정적 실패를 구분하지 않는다.** G-1, G-4, P-3, S-8, S-9, X-4, X-7이 같은 모양이다: 타임아웃·네트워크·공급자 오류가 "이 항목은 실패"로 영구 기록되거나, 반대로 한 번의 장애가 전체 실행을 끝낸다. 오류에 `transient` 분류를 싣고(일부 `AppError`에는 이미 재시도 가능 플래그가 있다) 공통 재시도·백오프 도우미를 둔다.
4. **되돌리기와 스냅샷이 행 단위가 아니다.** D-3, D-8, D-9, M-9. 병합 되돌리기를 행 단위 기록으로 바꾸고 `changes`가 병합된 id를 따라가게 한다.
5. **JSON 열 중심 스키마와 마이그레이션 부재.** E-2, E-9, D-17. 자주 거르고 정렬하는 필드를 생성 열과 표현식 색인으로 올리려면 먼저 `user_version` 기반 마이그레이션 러너가 필요하다. 이것이 선행 작업이다.

---

## 5. 권장 실행 순서

**1단계: 작고 안전한 수정 (각각 몇 줄에서 수십 줄, 독립적)**
M-1, D-6, D-12, D-13, D-2(`exportBib`와 `normalizeDoi`), F-3, X-1, X-2, G-5, G-6, S-4, S-7, P-2, P-4, R-1, R-8, R-10, R-11, R-12, E-3, E-9의 색인 추가. 각각 회귀 테스트 하나씩과 함께 넣기 좋다. 기존 `tests/integration`에 대응하는 스위트(bibtex, passages, shelf, genealogy-write 등)가 있다.

**2단계: 관측 가능성과 생명주기**
M-10(로그 파일, 전역 핸들러) → M-3(백오프, 치명적 오류 전달) → M-6 → M-4. 이후 단계의 현장 진단이 여기에 의존한다.

**3단계: 데이터 정합성**
D-1 → D-3/D-9(행 단위 병합 되돌리기) → D-4, D-8 → S-1, S-2, S-3 → D-5, D-7 → F-1, F-2.

**4단계: 색인 품질과 리포트 견고성**
P-1(청커, 버전 상승으로 전체 재색인이 일어나므로 P-5, P-6과 한 번에) → P-3, S-8, S-9 → G-1, G-2, G-3, G-4, G-8.

**5단계: 성능**
E-1 → E-5 → E-2(마이그레이션 러너 D-17 선행) → E-4 → E-6, E-7 → E-13, E-14, E-15 → E-18, E-19, E-20(R-5, R-6과 함께).

---

## 6. 확인했고 문제없다고 본 부분

다시 감사할 필요가 없도록 기록한다.

- **SQL**: IN 목록은 전부 `json_each(?)`를 써서 변수 개수 한도에 걸리지 않는다. 문자열 보간은 상수 테이블 이름에만 쓰인다. 탐색과 BibTeX 가져오기는 트랜잭션으로 묶여 있다.
- **파일 쓰기**: 백업, managed 사본, PDF 내보내기는 스테이징 뒤 rename하고 `finally`에서 정리한다. 백업 매니페스트 경로는 정규식으로 제한되고 realpath·심볼릭 링크 검사를 거친다.
- **하위 프로세스**: 모든 spawn이 argv 배열을 쓰고 모델 이름은 `--model`의 값으로만 들어간다. Codex와 Claude는 허용 목록 환경을 받는다. Claude는 `--tools ""`로, Codex는 기능 비활성화와 서버 발신 요청 거부로 돌아 논문 텍스트가 LLM 도구 호출에 닿지 않는다.
- **JSON-RPC**(`codex/transport.ts`): 대기 요청이 종료·닫힘·타임아웃·중단에서 모두 거부되고 부분 줄 프레이밍이 처리된다. CDP도 닫힘과 타임아웃에서 대기 Promise를 거부하고 리스너를 정리한다.
- **인용 검증**: 환각 인용 키는 `parseSection`, `reviewChecks`, citeproc에서 거듭 검증된다. 장 파일 이름은 정제되어 경로 탈출이 없다. 확장 라운드·쓰기 패스·절별 재작성에는 모두 상한이 있다.
- **서고**: 분리 감지(`rootOnline` 걷기 전후, `assertOnline`, 20% 확인 게이트)는 S-4와 S-5를 빼면 견고하다. 심볼릭 링크와 점 파일은 건너뛴다. 폴더 이름 변경은 이동으로 잡힌다. `adoptManaged`는 앱 사본을 지우기 전에 해시를 확인한다.
- **벡터 연산**: Ollama 출력은 L2 정규화되고 영벡터와 차원 불일치가 방어된다. 인용문 검증은 양쪽을 같은 방식으로 접는다.
- **전문 확보**: 오래된 Chrome 종료 가드는 프로필 경로를 확인한다. 리디렉션 루프는 홉마다 공개 URL을 검사한다. Content-Type보다 PDF 매직 바이트를 믿는다. DB를 열 때 running·queued 실행을 "interrupted"로 바꾼다.
- **렌더러**: list·inspect·link·export 효과는 유효성 플래그를 써서 오래된 응답이 새 상태를 덮지 않는다. `refreshQueue`에 겹침이나 갱신 누락이 없다. Louvain·PageRank·지름 스케일은 빈 그래프, 단일 노드, 비연결 그래프에서 NaN이나 0으로 나누기가 없다. `dangerouslySetInnerHTML`이 없고, AI 사이드바 답변은 링크와 이미지를 무력화하며, 창의 `navigationRules`가 외부 이동을 막는다. Graph의 cytoscape·옵저버·타이머·리스너는 언마운트에서 정리된다.
- **메인**: `openExternal`·`chatOpenSource`·`codexLogin`의 URL 검증, `genealogyChapter`의 경로 검사, PDF 워커의 타임아웃과 종료, init의 멱등성, 자기 병합 가드.
