# PubMed Linked Discoveries 연동 · 2026-10-08

## 배경

`관련 논문` 탐색은 현재 OpenAlex `related_works`(논문당 약 10편)를 seed 이웃으로 쓴다. 생의학 논문에서는 이 목록의 품질이 낮다. 예를 들어 PMID 38772598(NTRK3 재배열 전립선 선방세포 선암)의 `related_works`에는 소아 심장 재이식, 합창단 공연 안내문, 제약사 뉴스가 섞여 있다.

NLM이 2026-09-24 실험 서비스로 공개한 [Linked Discoveries](https://linkeddiscoveries.ncbi.nlm.nih.gov/)는 PubMed 2,900만 편 이상에 대해 임베딩 기반 "vector neighborhood"를 제공한다. 같은 seed로 조회하면 NTRK·BRAF 융합 전립선암 증례와 TRK 억제제 리뷰가 상위에 온다. PubMed 공식 Similar articles(`elink pubmed_pubmed`)와는 상위 20편 중 1편만 겹치므로, 기존 신호와 성격이 다른 독립 신호로 볼 수 있다.

공개 API는 없다. 웹 프런트엔드가 쓰는 내부 JSON 엔드포인트를 앱이 직접 호출한다. 사설 프록시나 자체 임베딩 서버는 범위에서 제외한다.

## 엔드포인트 조사 결과 (2026-10-08 확인)

- `GET https://linkeddiscoveries.ncbi.nlm.nih.gov/{pmid}/`: HTML 페이지. 응답의 `Set-Cookie`로 `linked-discoveries-csrftoken`을 발급한다. 없는 PMID는 404.
- `POST https://linkeddiscoveries.ncbi.nlm.nih.gov/{pmid}/links/`
  - 헤더: `Cookie: linked-discoveries-csrftoken=<t>`, `X-CSRFToken: <t>`, `Content-Type: application/x-www-form-urlencoded`
  - 본문: `neighbors=20|50|100|200`. 그 외 값은 `400 {"error":"Invalid form data"}`.
  - 한 번 받은 토큰을 다른 PMID 요청에도 재사용할 수 있다. Referer 헤더는 없어도 되고, 쿠키 저장소 없이 헤더만으로도 동작한다.
  - GET은 405를 반환한다. 존재하지 않는 PMID는 200과 함께 빈 `articles`를, 초록이 없는 논문은 seed 1건만 반환한다.
  - 응답 시간은 20개 0.5–1초, 200개 약 3.7초(약 770KB).
- 응답 최상위 필드: `seedArticleId`, `realCount`, `articles[]`, `diseases`, `genes`, `chemicals`(ID → 이름 사전), `citationEdges`(`[citing, cited]` PMID 쌍), `diseaseHierarchy`, `synTiers`, `generated`.
- `articles[]` 필드: `articleId`(PMID), `isSeed`, `score`(seed 1.0, 이웃은 대략 0.65–0.72), `title`(HTML), `authors[]`, `journal`, `publicationYear`, `abstract.sections[].paragraphs[]`(HTML), `publicationTypes`, `isReview`, `isRetracted`, `hasNIHFunding`, `diseases`(MedGen CUI), `genes`(`NCBIGene:n`), `chemicals`(`PUBCHEM.COMPOUND:n`). 배열 순서는 점수순이 아니다.
- 이웃 200편을 OpenAlex `filter=pmid:a|b|…`로 해석하면 199편이 나온다.

비공식 엔드포인트이므로 스키마·경로·CSRF 방식은 예고 없이 바뀔 수 있다. 공식 이용약관과 요청 한도는 확인하지 못했다. 이 연동은 **실패해도 기존 탐색이 그대로 동작하는 보강 신호**로 설계한다.

## 범위

### 1단계 (이번 구현)

1. Linked Discoveries 제공자 모듈 (CSRF 세션, 캐시, 속도 제한, 느슨한 스키마 검증)
2. `Work`에 PMID 보존 및 PMID 식별자 색인
3. `관련 논문` 모드에 Linked Discoveries 이웃 단계 추가. 이웃 PMID는 OpenAlex로 해석해 기존 후보 흐름에 넣는다.
4. 랭킹과 근거에 유사도 점수 반영, 후보 근거에 출처 표시
5. 설정의 실험 기능 토글과 Inspector의 "Linked Discoveries에서 보기" 링크
6. 결정적 통합 테스트와 live smoke

### 2단계 (후속)

- 질병·유전자·화학물질 개체를 후보 facet 필터로 노출 (`Filters` 확장)
- OpenAlex에 없는 PMID(약 0.5%)를 Linked Discoveries 레코드로 직접 `Work` 생성
- 여러 seed에서 공통으로 나온 이웃 가중 (`commonLinked` 모드 후보)
- `isReview` 기반 "리뷰만" 빠른 필터

### 제외

- 사설 API·중앙 프록시·자체 임베딩 인덱스
- `citationEdges` 반영: 그래프 인용선은 이미 OpenAlex `referenced_works`로 만든다(`Library.edges`). 같은 관계를 중복 저장하지 않는다.
- Linked Discoveries 초록 사용: 초록은 OpenAlex 것을 유지하고, 출판사 저작권 텍스트를 따로 저장하지 않는다.

## 설계

### 1. 제공자: `src/service/providers/linked-discoveries.ts`

`OpenAlex` 클래스와 같은 형태로 만든다. 생성자는 `library`(캐시), `fetcher`(테스트 주입용)를 받는다.

```ts
export interface LinkedNeighbor {
  pmid: string;
  score: number;
  isReview: boolean;
  isRetracted: boolean;
  diseases: string[];
  genes: string[];
  chemicals: string[];
}
export interface LinkedNeighborhood {
  seedPmid: string;
  neighbors: LinkedNeighbor[]; // seed 제외, score 내림차순
  entities: { diseases: Record<string, string>; genes: Record<string, string>; chemicals: Record<string, string> };
  cached: boolean;
  fetchedAt: string;
}
class LinkedDiscoveries {
  neighbors(pmid: string, size: 20 | 50 | 100 | 200, signal: AbortSignal, onCall: () => void): Promise<LinkedNeighborhood>;
}
```

- **CSRF 세션**: 메모리에 토큰 하나를 둔다. 없으면 `GET /{pmid}/`로 받아 `Set-Cookie`에서 `linked-discoveries-csrftoken`을 파싱한다. Bun `fetch`에는 쿠키 저장소가 없으므로 `Cookie` 헤더를 직접 만든다. POST가 403이면 토큰을 버리고 한 번만 재발급해 재시도한다.
- **요청 헤더**: `User-Agent: ResearchBunny/<version> (literature discovery desktop app)`. 기존 `pubmed-search.ts`·`fulltext/engine.ts`의 UA 문자열 형식에 맞춘다.
- **속도 제한**: 앱 전체에서 직렬화하고 요청 간격은 최소 1초로 한다. `pubmed-search.ts`의 `reserveRequest` 패턴을 그대로 쓴다. 웹 페이지 한 번 열람과 비슷한 부하를 목표로 한다.
- **타임아웃·재시도**: 30초 타임아웃(200개 응답 고려). 네트워크 오류와 5xx는 2회 재시도하고, 429는 `RATE_LIMIT`로 처리한다.
- **캐시**: 키 `ld:v1:{pmid}:{size}`, TTL 7일. 원본 응답이 아니라 축약한 `LinkedNeighborhood`만 저장한다(제목·초록·저자 제외, 200개 기준 수십 KB).
- **스키마**: zod `passthrough`로 `articles[].articleId/score/isSeed`만 필수로 두고 나머지는 선택으로 둔다. 필수 필드가 깨지면 `AppError("PROVIDER_SCHEMA", …)`.
- **사용량 기록**: `library.usage("linked-discoveries", runId)`.

### 2. PMID 보존

- `Work`에 `pmid: string | null` 추가 (`src/shared/types.ts`). `blankWork` 기본값은 `null`.
- `fromOpenAlex`에서 `ids.pmid`(예: `https://pubmed.ncbi.nlm.nih.gov/38772598`)를 숫자 문자열로 정규화한다. `rawSchema`에 `ids`를 선택 필드로 추가한다.
- `src/shared/domain.ts`에 `normalizePmid(value)`를 추가한다. 숫자 PMID, PubMed URL, `pmid:` 접두어를 받는다.
- `Library.identities`에 `["pmid", w.pmid]`를 추가한다. 기존 레코드는 다음 upsert에서 채워진다.
- 이미 저장된 `Work`는 `pmid`가 없을 수 있다. 읽을 때 `work.pmid ?? normalizePmid(work.raw?.ids?.pmid)`로 보완하는 `pmidOf(work)` 헬퍼를 두고, 별도 마이그레이션은 하지 않는다.
- PMID 기반 lookup도 지원한다. `OpenAlex.lookup`이 `pmid:`를 받으면 `works/pmid:{n}`을 호출하고, 검색창에 PMID를 넣었을 때도 동작하게 한다(`engine.start`의 identifier 분기).

### 3. 탐색 엔진 (`src/service/discovery/engine.ts`)

`Task.kind`에 두 가지를 추가한다.

- `"linked"`: `query`에 seed PMID, `seedId`, `origin: "PubMed 의미 이웃"`
- `"pmidBatch"`: `ids`에 PMID 최대 100개, `origin`은 위와 같다.

`makeTasks`의 `related` 모드 처리:

```
각 seed에 대해
  pmid = pmidOf(w)
  if (설정 on && pmid) → linked 작업을 맨 앞에(unshift)
  OpenAlex related_works batch는 linked 작업이 실패하거나 PMID가 없을 때만 실행
```

OpenAlex related_works 대체 방식은 아래 "결정 사항" 1번을 따른다. PMID가 없는 seed는 지금처럼 처리한다.

`execute` 루프에서 `linked` 작업은 후보를 직접 만들지 않는 **확장 작업**이다.

1. `ld.neighbors(pmid, size, …)`를 호출한다.
2. 결과를 `run.linked[seedId] = { pmid → score, isReview, … }`에 저장한다. `Run`에 `linked?: Record<string, Record<string, LinkedNeighbor>>` 필드를 추가한다.
3. 이웃 PMID를 100개씩 나눠 `pmidBatch` 작업으로 `run.tasks`에 넣는다.
4. 작업을 `done`으로 표시하고 `continue`한다. 기존 `ai-plan` 단계처럼 `saveRun` 후 다음 작업으로 넘어간다.

`pmidBatch`의 `fetchTask`는 `oa.page({ filter: "pmid:" + ids.join("|"), per_page: "100" }, …)`이다. 결과 `Work`가 기존 경로(upsert → candidate)를 그대로 탄다.

**이웃 개수**: seed 1편이면 100, 2–3편이면 seed당 50, 4편 이상이면 seed당 20. 모두 `neighbors` 허용값 안에서 정한다. 후보 상한(`maxCandidates`)은 그대로 둔다.

**호출 예산**: `linked` 호출도 `onCall`을 거쳐 `run.calls`에 포함한다. 다만 `library.usage` provider는 따로 기록한다.

**실패 처리**: `linked` 작업의 실패는 `RATE_LIMIT`과 `CANCELLED`를 제외하고 run을 실패시키지 않는다.
- `run.linkedFailures`에 사유를 기록한다.
- 해당 seed의 OpenAlex related_works batch를 대신 추가한다.
- 완료 메시지 끝에 `· PubMed 의미 이웃 미조회 n편`을 붙인다. 기존 `unresolved` 메시지 패턴을 따른다.

### 4. 랭킹과 근거

`Evidence`에 선택 필드를 추가한다.

```ts
linked?: { score: number; seedIds: string[]; isReview?: boolean };
```

- `execute`에서 후보를 만들 때, 작업이 `pmidBatch`이고 `run.linked`에 해당 PMID가 있으면 `evidence.linked`를 채운다.
- `rank`에서 같은 work가 여러 seed의 이웃이면 `score`는 최댓값, `seedIds`는 합집합으로 둔다.
- 점수 가산 초안(픽스처로 보정 예정):

  ```
  linkedBoost = min(0.20, max(0, linked.score - 0.60) * 1.5) + min(0.05, (linked.seedIds.length - 1) * 0.025)
  ```

  기존 `content.score`(TF-IDF/토픽)를 대체하지 않고 더한다. 초록이 없어 `deferred`인 후보도 Linked 점수가 있으면 보류 표시는 유지하되 순위는 올라가게 한다.
- `reasons`에는 `PubMed 의미 이웃 · 유사도 0.71`을 추가한다. 여러 seed에서 나오면 `PubMed 의미 이웃 · 출발 문헌 2편 공통`을 쓴다.
- `origins`에는 작업 origin(`PubMed 의미 이웃`)이 그대로 들어가므로 기존 근거 UI에 자동으로 나타난다.

### 5. UI

- **설정** (`Settings.tsx`): "PubMed Linked Discoveries 사용 (실험적)" 토글과 설명문을 넣는다. 설명문 내용은 "생의학 논문의 관련 논문 탐색에 NLM의 의미 이웃을 함께 사용합니다. 공식 API가 아니어서 동작이 바뀔 수 있으며, 실패하면 OpenAlex만 사용합니다."이다. 기본값은 꺼짐이며 기존 preferences 저장소를 사용한다. 저장된 설정에 값이 없는 기존 사용자도 꺼짐으로 해석한다.
- **탐색 메뉴** (`DiscoveryMenu.tsx`): 메뉴 항목은 늘리지 않는다. `관련 논문` 안에서 자동으로 쓰인다.
- **진행 메시지**: 기존 `run.message`의 `${task.origin} 조회 중` 형식을 그대로 쓴다.
- **Inspector**: 선택 논문에 PMID가 있으면 외부 링크 `Linked Discoveries에서 보기 ↗`(`https://linkeddiscoveries.ncbi.nlm.nih.gov/{pmid}/`)를 넣는다. 기존 외부 링크 열기 경로와 `safeWebUrl`을 재사용한다. 이 링크는 앱이 요청을 보내지 않으므로 토글과 관계없이 표시한다.
- **후보 근거 표시**: `evidence.reasons`가 이미 렌더링되므로 추가 컴포넌트는 필요 없다.

### 6. 계약·타입 변경 요약

| 파일 | 변경 |
|---|---|
| `src/shared/types.ts` | `Work.pmid`, `Task.kind`에 `linked`·`pmidBatch`, `Run.linked`·`Run.linkedFailures`, `Evidence.linked` |
| `src/shared/domain.ts` | `normalizePmid`, `pmidOf`, `blankWork.pmid` |
| `src/shared/contracts.ts`, `src/shared/types.ts` (`Settings`) | `saveSettings` 입력과 `Settings`에 `linkedDiscoveries: boolean` (기본 `false`) |
| `src/service/providers/openalex.ts` | `rawSchema.ids`, `fromOpenAlex` PMID, `lookup`의 `pmid:` 지원 |
| `src/service/providers/linked-discoveries.ts` | 신규 |
| `src/service/discovery/engine.ts` | 작업 생성·확장·랭킹 |
| `src/service/db/database.ts` | `identities`에 pmid |
| `src/service/service.ts` | 제공자 생성과 `Discovery` 주입 |
| `src/renderer/components/Settings.tsx`, `Inspector.tsx` | 토글, 외부 링크 |

DB 스키마 변경은 없다. `works.data`는 JSON이고, `identifiers`는 provider 문자열로 구분된다.

## 결정 사항 (2026-10-08 확정)

1. **OpenAlex related_works 처리**: Linked Discoveries 조회에 성공한 seed는 OpenAlex related_works를 **건너뛴다**. 실패했거나 PMID가 없을 때만 사용한다. 근거는 위 예시처럼 related_works의 잡음이 크다는 점이다.
2. **기본 활성화**: 토글 기본값은 **꺼짐**. 비공식 엔드포인트이므로 사용자가 설정에서 직접 켜야 호출한다. 꺼져 있으면 `관련 논문`은 현재 동작(OpenAlex related_works 포함)과 같다.
3. **이웃 개수**: seed 1편이면 100, 2–3편이면 seed당 50, 4편 이상이면 seed당 20 (3절 "이웃 개수"). 더 넓은 탐색은 `more`(추가 조회)에서 `size`를 한 단계 올려 다시 요청한다(최대 200).

## 테스트

픽스처 `tests/fixtures/linked-discoveries-38772598.json`을 둔다. 실제 응답에서 이웃 10편과 필수 필드만 남기고 초록·저자는 비운다. 신규 `tests/integration/linked-discoveries.test.ts`가 다룰 내용:

- 제공자: CSRF 쿠키 파싱, 403 시 토큰 재발급 1회, 400/빈 결과/스키마 위반 처리, 점수 내림차순 정렬, seed 제외, 캐시 적중 시 네트워크 미호출, 속도 제한 간격, abort.
- PMID: `fromOpenAlex`의 `ids.pmid` 정규화, `normalizePmid` 입력 형식, 식별자 색인으로 같은 논문 병합, 기존 레코드의 `raw` 보완.
- 엔진: PMID seed의 `related` 실행 시 `linked` → `pmidBatch` → 후보 생성 순서, PMID 없는 seed는 기존 경로만, Linked 실패 시 related_works 대체와 완료 메시지, Linked 성공 seed의 related_works 미실행, 토글 off(기본값)일 때 Linked Discoveries 미호출과 기존 작업 목록 동일성, 설정값이 없는 기존 사용자의 off 해석, 여러 seed 공통 이웃의 `seedIds` 병합.
- 랭킹: 같은 TF-IDF 점수에서 Linked 점수가 높은 후보가 앞에 오고 `reasons` 문자열이 들어간다.
- 회귀: 기존 `library`, `graph`, `pending`, `refresh` 테스트 전체 통과.
- Live smoke (`scripts/live-smoke.mjs`): PMID 38772598에 대해 실제 엔드포인트가 이웃 20개 이상을 반환하고 OpenAlex 해석률이 90% 이상인지 확인한다. 엔드포인트 변경을 조기에 감지하는 용도이며 CI 기본 테스트에는 넣지 않는다.

검증 순서: `bun run typecheck` → `bun run lint` → `bun run test` → `bun run test:live` → 개발 빌드에서 실제 `관련 논문` 실행 후 근거·순위·설정 토글·Inspector 링크를 확인한다.

## 위험과 대응

| 위험 | 대응 |
|---|---|
| 엔드포인트·스키마 변경 | 느슨한 스키마, 실패 시 OpenAlex 대체, live smoke로 조기 감지, 토글로 즉시 끄기 |
| NCBI 측 차단·요청 한도 | 사용자 PC에서 직접 호출, 1 req/s 직렬화, 7일 캐시, 식별 가능한 User-Agent |
| 이용 조건 불명확 | 실험 기능으로 표시하고 문서에 비공식임을 명시. 공식 API가 나오면 제공자 내부만 교체 |
| PMID 없는 분야(CS·물리 등) | 해당 seed는 기존 경로만 사용하고 UI에 별도 경고는 띄우지 않음 |
| 점수 보정 부족 | 가산식을 상수로 분리하고, 실제 프로젝트 2–3개로 순위 변화를 비교한 뒤 조정 |
