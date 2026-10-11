# 서고 통합 계획: 보관 PDF 열람 · 관련 문헌 추천 · 서고 우선 검색

작성 2026-10-11 · 기준 버전 0.2.10 · 상태: 계획 (코드 변경 없음)

## 1. 배경과 목표

ResearchBunny는 새 주제에서 출발해 문헌을 찾고, 고른 논문을 프로젝트별 아카이브에 모으도록 만들어졌다. 그런데 사용자는 이미 `/Volumes/LIBRARY/Articles`에 PDF 8,322편을 63개 주제 폴더로 정리해 두었고, 앱은 이 자료를 모른다. 그래서 모아 둔 논문을 다시 찾아 쓰기 어렵고, 새 주제를 검색하면 이미 가진 논문을 또 내려받게 된다.

이번 작업의 목표는 세 가지다.

1. **서고 열람**: 디스크의 폴더 구조대로 논문 목록을 보여 준다. 논문을 누르면 지금의 Inspector로 서지사항과 초록을 보여 주고, PDF는 기존 원문 보기로 연다.
2. **관련 문헌 추천**: 로컬 Ollama의 `embeddinggemma-2`로 각 논문의 초록을 임베딩하고, 지금 보고 있는 논문과 가까운 서고 논문을 추천한다.
3. **서고 우선 검색**: 질의를 받으면 서고부터 찾아 보여 준다. 외부 검색 결과 중 이미 가진 논문에는 표시를 붙이고, 원문 확보 작업은 서고 PDF를 먼저 연결해 재다운로드를 막는다.

## 2. 현황 조사 (2026-10-11 확인)

### 2.1 서고 `/Volumes/LIBRARY/Articles`

| 항목 | 값 |
|---|---|
| 저장 위치 | Synology NAS SMB 공유(`//AnselmJeong@Synology/LIBRARY`), smbfs 마운트 |
| PDF | 8,322개, 약 32GB |
| 폴더 | 11개 도메인 × 63개 말단 폴더(2단계). 루트에 미분류 PDF 99개, `_duplicated` 27개, `_uncategorized` 0개 |
| 그 밖의 파일 | `_system/`(분류 도구·로그·캐시), `_summaries/`(md 요약), `index.json`, xlsx 1개 |
| 파일명 | `연도 - 저자 - 제목.pdf` 형식 99.7% (8,265/8,290) |
| 1–2쪽 DOI 검출 | 58% 이상 (4,836/8,290). `_system/p1.jsonl`이 2,600자로 잘린 캐시라 실제 검출률은 더 높을 것 |
| 1–2쪽에 "Abstract/Summary" 단어 포함 | 43% |
| 텍스트 없는 PDF(스캔본 추정) | 10건 |
| 출판 연도 | 2020년대 94%, 2010년대 5% |

이 서고는 앱 밖의 도구가 관리한다. `_system/intake.py`와 `_system/ROUTING.md`의 절차에 따라, 루트에 들어온 PDF를 말단 폴더로 옮기고 `index.json`을 다시 만든다. 운영 지침은 파일명을 바꾸지 말 것(파일명이 곧 메타데이터), 카테고리 이름을 임의로 바꾸지 말 것을 요구한다. 그래서 앱은 다음 원칙을 지킨다.

- 서고를 **읽기 전용**으로 다룬다. 파일 이동, 이름 변경, 사이드카 파일 생성을 하지 않는다.
- 파일은 경로가 아니라 **내용 해시**로 식별한다. `intake.py`가 파일을 옮기면 이동으로 인식하고 기존 서지와 임베딩을 유지한다.
- 폴더 트리는 디스크를 그대로 보여 준다. 앱에서 폴더를 편집하지 않는다.

### 2.2 Ollama와 EmbeddingGemma 2

- 로컬 Ollama 0.40.2가 `127.0.0.1:11434`에서 실행 중이다. 2026-10-11에 `embeddinggemma-2:latest`(digest `969600645b52`, 1.3GB, 768차원)를 받았다. 측정 결과는 8장 Phase 0에 적었다.
- `ollama.com/library/embeddinggemma-2` (4일 전 공개)
  - 태그: `latest` 1.3GB(텍스트·이미지), `270m` 378MB(텍스트), `440m` 714MB(텍스트·이미지), `570m` 990MB(텍스트)
  - 출력 768차원. MRL로 512/256/128차원 절단 가능하며 256차원까지는 품질 손실이 작다.
  - 입력 8,192 토큰, 100개 이상 언어 지원. 한국어 질의로 영어 초록을 찾을 수 있다.
  - 작업별 텍스트 접두어(task prefix)를 쓰는데, Ollama 페이지에는 정확한 형식이 없다. Phase 0에서 Google 모델 카드로 확인한다.
- 기존 `OllamaCloud`(`src/service/providers/ollama.ts`)는 `ollama.com` 클라우드 채팅 전용이고 API 키가 필수다. 로컬 임베딩 클라이언트는 따로 만든다.

### 2.3 그대로 재사용할 수 있는 것

- `works`와 `attachments`는 전역이고, 프로젝트 소속은 `project_works`가 따로 관리한다. 서고 논문을 전역 work로 두고 필요할 때만 프로젝트에 저장하는 구조가 여기에 그대로 맞는다.
- 식별자 통합(`Library.upsert`/`match`)은 DOI·PMID·OpenAlex ID가 같으면 같은 work로 합친다. 서고 논문과 프로젝트 논문의 DOI가 같으면 자동으로 한 레코드가 되고, 서고 PDF가 그 프로젝트에서도 보인다.
- `attachments`의 `linked` 모드는 원본 위치를 가리키는 첨부다. 32GB를 복사할 필요가 없다.
- PDF 처리 부품: `scan`, `hashFile`, `verifyPdf`, `extractPdf`(별도 프로세스, 시간 제한 있음), `isAuxiliaryPdf`, `matchesDownloadedPdf`의 DOI·제목 판정 규칙.
- OpenAlex의 `filter=openalex:a|b|…`·`pmid:` 묶음 조회 방식, PubMed `efetch` 초록 조회.
- Inspector `초록` 탭, `ArticleReader`, AI sidebar, 목록·그래프·연도 보기와 필터.
- `mergeScholarlyResults`의 RRF 결합(1/(60+rank)).
- bun:sqlite(SQLite 3.54.0)는 FTS5를 지원한다. 별도 의존성 없이 어휘 검색 색인을 만들 수 있다.

### 2.4 고쳐야 하는 것

| 위치 | 현재 동작 | 8천 편에서 생기는 문제 |
|---|---|---|
| `PdfImports` (`interchange/pdf.ts`) | 실행당 OpenAlex 40회 상한. `Run.import.paths`에 전체 경로를 넣고 파일마다 run JSON 전체를 다시 저장. 프로젝트 소속·후보·컬렉션을 만듦 | 대부분 파일이 DOI 조회 없이 임시 서지로 남는다. 1MB가 넘는 JSON을 8천 번 다시 쓴다. 검토 대기함이 8천 편으로 찬다. 서고 색인에는 이 클래스 대신 부품만 쓴다 |
| `Library.list` | 문헌마다 `view()`로 쿼리 4개 실행(N+1) | 서고 전체 목록에 쿼리 3만 개 이상 |
| `Library.edges` | 목록을 열 때마다 `citations` 전체(현재 17만 행)를 조인해 읽고 JS에서 거름 | 서고 work의 참고문헌이 더해지면 50만 행을 넘는다 |
| `duplicates` 명령 | 모든 work를 하나씩 `get()`해 제목 비교 | work가 1만 편을 넘으면 매번 전체 파싱 |
| `hasValidPdf` | 확인할 때마다 첨부 전체 SHA-256 재계산 | SMB 위 PDF를 원문 확보 미리보기 때마다 끝까지 읽는다 |
| work 레코드 크기 | 현재 2,036편, 평균 32.7KB(`raw`에 OpenAlex 원본 전체) + `metadata_snapshots` 사본. DB 291MB | 서고 8천 편을 같은 방식으로 넣으면 DB가 약 0.8GB가 되고 백업(`VACUUM INTO`)도 느려진다 |
| 영구 삭제(`db/trash.ts`) | 어느 프로젝트에도 속하지 않은 work는 첨부와 함께 삭제 | 프로젝트에서 지운 서고 논문이 서고에서도 사라진다 |
| 병합(`db/merge.ts`) | 정해진 테이블의 `work_id`만 옮김 | 새 서고 테이블을 옮기지 않으면 참조가 깨진다 |
| `list` 계약 | `scope` enum 고정, `scopeId` 160자 제한 | 폴더 경로를 ID로 쓸 수 없다. 폴더 ID가 필요하다 |
| UI 용어 | "아카이브"는 이미 "프로젝트에 저장한 문헌"을 뜻함 | 같은 이름을 쓰면 헷갈린다 |

## 3. 설계 결정

1. **서고는 프로젝트 밖의 전역 계층이다.** 8천 편은 특정 프로젝트가 고른 결과가 아니라 모든 프로젝트가 함께 쓰는 자료다. 서고 논문은 전역 `works`에 넣고 `project_works`에는 넣지 않는다. 사용자가 "프로젝트에 저장"할 때만 소속이 생긴다. 서고 전용 프로젝트를 만드는 방식은 검토 대기함, 소주제 분류, 카운트, 내보내기 범위를 모두 오염시키므로 쓰지 않는다.
2. **UI 이름은 "서고", 코드 이름은 `shelf`로 한다.** 기존 "아카이브"와 구분하기 위해서다.
3. **서고는 읽기 전용이다.** 색인, 서지, 임베딩은 모두 `library.sqlite`에 저장한다.
4. **파일은 SHA-256으로 식별하고 위치는 상대 경로로 따로 관리한다.** 이동을 감지하면 첨부 경로만 고친다.
5. **첨부는 `linked` 모드로 연결한다.** NAS가 연결되지 않아도 서지, 초록, 추천은 동작하고 PDF 열기만 막힌다.
6. **임베딩은 work 단위로 저장하고, 모델·프롬프트·입력 텍스트로 버전을 관리한다.** 벡터 DB는 쓰지 않는다. SQLite BLOB에 저장하고 서비스 프로세스 메모리에서 전수 비교한다. M2 Max에서 Bun으로 잰 전수 비교 top-k 시간은 아래와 같다(2026-10-11).

   | 편수 | 768차원 | 256차원(MRL) | 메모리(768차원) |
   |---|---|---|---|
   | 8,322 (현재) | 5.9 ms | 1.9 ms | 24 MB |
   | 25,000 (3배) | 17 ms | 5.6 ms | 73 MB |
   | 50,000 | 35 ms | 11 ms | 147 MB |
   | 100,000 | 69 ms | 23 ms | 293 MB |

   25,000개 벡터를 SQLite에서 읽어 행렬로 올리는 데 62ms, 쓰는 데 385ms가 걸렸다. 질의 임베딩은 모델이 메모리에 있을 때 p50 27ms, p95 55ms다. 3배로 늘어도 검색 한 번에 질의 임베딩까지 합쳐 50ms 안팎이다. 벡터 검색은 `VectorIndex` 인터페이스(`upsert`, `remove`, `search`) 뒤에 두어, 나중에 바꿀 때 이 모듈만 고치게 한다. 근사 최근접 색인이 필요해지는 시점은 논문 수가 아니라 단위가 바뀔 때다. PDF 본문을 청크로 나눠 임베딩하면(논문당 수십 개, 25,000편이면 약 100만 벡터) 전수 비교가 수백 ms가 되므로, 그때 int8 양자화나 HNSW(`sqlite-vec` 등)를 검토한다.
7. **검색은 어휘 검색(FTS5 BM25)과 의미 검색(벡터)을 RRF로 합친다.** 한국어 질의는 의미 검색이 받는다. Ollama가 꺼져 있으면 어휘 검색만 하고 그 사실을 표시한다.
8. **모든 질의는 서고부터 본다.** 검색 결과 위에 "내 서고에서 찾음" 묶음을 고정하고, 외부 결과 중 서고에 있는 논문에 표시를 붙인다. 원문 확보도 서고를 먼저 확인한다.
9. **임베딩과 질의 텍스트는 이 Mac 밖으로 나가지 않는다.** 서지 확인에는 지금처럼 DOI와 제목만 OpenAlex·PubMed에 보낸다. PDF 본문은 외부로 보내지 않는다.

## 4. 데이터 모델 (schema 3)

```sql
CREATE TABLE IF NOT EXISTS shelf_roots(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,              -- /Volumes/LIBRARY/Articles
  name TEXT NOT NULL,                     -- 'Articles'
  exclude TEXT NOT NULL,                  -- JSON 배열, 기본값 ["_system","_news","_to_delete","_duplicated"]
  created_at TEXT NOT NULL,
  last_scan_at TEXT
);
-- id = sha256(root_id + '/' + rel_path)의 앞 32자. 재스캔해도 같은 ID가 나온다.
CREATE TABLE IF NOT EXISTS shelf_folders(
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES shelf_roots(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,                 -- '' = 루트(수신함)
  parent_id TEXT,
  name TEXT NOT NULL,
  present INTEGER NOT NULL DEFAULT 1,
  UNIQUE(root_id, rel_path)
);
CREATE TABLE IF NOT EXISTS shelf_files(
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES shelf_roots(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES shelf_folders(id),
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  hash TEXT,                              -- SHA-256. 계산 전에는 NULL
  hashed_size INTEGER,                    -- 해시를 계산한 시점의 크기·mtime
  hashed_mtime INTEGER,
  work_id TEXT REFERENCES works(id),
  attachment_id TEXT,
  stage TEXT NOT NULL,                    -- found|hashed|extracted|resolved|embedded
  status TEXT NOT NULL,                   -- ok|review|provisional|auxiliary|failed|missing
  info TEXT NOT NULL,                     -- JSON: 파일명 파싱, 추출 DOI, 판정 근거, 후보, 오류
  seen_at TEXT NOT NULL,
  missing_since TEXT,
  UNIQUE(root_id, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_shelf_files_folder ON shelf_files(folder_id);
CREATE INDEX IF NOT EXISTS idx_shelf_files_hash ON shelf_files(hash);
CREATE INDEX IF NOT EXISTS idx_shelf_files_work ON shelf_files(work_id);
CREATE INDEX IF NOT EXISTS idx_shelf_files_stage ON shelf_files(stage, status);

CREATE TABLE IF NOT EXISTS work_embeddings(
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  model TEXT NOT NULL,                    -- 'embeddinggemma-2:270m@<digest 앞 12자>'
  prompt TEXT NOT NULL,                   -- 'eg2-doc-v1'
  basis TEXT NOT NULL,                    -- abstract|pdf-abstract|page1|title
  text_hash TEXT NOT NULL,                -- 임베딩한 입력 텍스트의 SHA-256
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,                   -- L2 정규화한 Float32Array
  created_at TEXT NOT NULL,
  PRIMARY KEY(work_id, model)
);
-- 질의와 서고 밖 문헌의 즉석 임베딩 캐시. 최대 5,000개, 오래 안 쓴 것부터 지운다.
CREATE TABLE IF NOT EXISTS embedding_cache(
  key TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, used_at TEXT NOT NULL
);
-- 어휘 검색 색인. 서고 work만 넣는다.
CREATE VIRTUAL TABLE IF NOT EXISTS shelf_fts USING fts5(
  work_id UNINDEXED, title, authors, abstract, venue,
  tokenize = 'unicode61 remove_diacritics 2'
);
PRAGMA user_version=3;
```

타입 변경 (`src/shared/types.ts`)

- `Attachment.shelfFileId?: string`: 서고 파일에서 온 첨부. 유효성 확인 fast path에 쓴다.
- `Evidence.shelf?: { score: number | null; folder: string; fileId: string }`: 검색 후보가 서고 논문일 때 붙인다.
- `Filters.shelf: "all" | "hide" | "only"`: 기본값 `"all"`.
- `Settings.shelf`: 루트 경로, 제외 폴더, 임베딩 모델, 색인 상태 요약.
- `Work.raw.abstractSource`: `"openalex" | "pubmed" | "pdf"`. PDF에서 뽑은 초록은 UI에 표시한다.

마이그레이션과 기존 코드 수정

- `SCHEMA`를 3으로 올린다. schema 2 백업은 계속 복원할 수 있어야 한다. 이전 앱은 schema 3 라이브러리를 열지 못하므로(`NEWER_SCHEMA`), 설치 전에 지금처럼 `app-backups/`에 앱과 DB 스냅샷을 남긴다.
- `deleteTrashedWorks`: `shelf_files`가 참조하는 work는 지우지 않는다. 프로젝트 소속만 제거한다.
- `mergeWorks`/`undoMerge`: `shelf_files.work_id`, `work_embeddings`, `shelf_fts`도 옮기고 되돌린다.
- 백업: 새 테이블은 `VACUUM INTO`에 자동으로 포함된다. 복원한 라이브러리의 서고 루트가 없으면 오프라인 상태로 연다.
- 서고에서 OpenAlex로 서지를 확인한 work는 `raw`를 줄여 저장한다. 앱 코드가 읽는 `raw` 필드는 `ids`, `best_oa_location`, `locations` 셋뿐이다(`domain.ts`, `fulltext/engine.ts`). 이 셋은 남기고 `abstract_inverted_index`(초록 복원 후), `counts_by_year`, `concepts`, `authorships[].institutions` 같은 큰 필드는 버린다. `metadata_snapshots`에도 줄인 사본을 넣는다. 줄였을 때의 크기는 Phase 0에서 잰다.

## 5. 색인 파이프라인

`src/service/shelf/indexer.ts`가 단계별로 처리한다. 각 파일의 진행 상태가 `shelf_files.stage`에 남기 때문에, 앱을 껐다 켜거나 취소한 뒤에도 남은 파일부터 이어서 처리한다. 프로젝트 단위인 `runs` 테이블은 쓰지 않는다. 진행 상황은 `AppEvent`에 `{ type: "shelf" }`를 추가해 알린다.

### 5.1 단계와 첫 색인 소요 추정

| 단계 | 하는 일 | 대상 | 동시성 | 첫 색인 추정 |
|---|---|---|---|---|
| 1. 스캔 | 폴더를 돌며 stat(크기·mtime). 파일명을 파싱해 **임시 work를 바로 만든다** | 전체 | 1 | 수십 초 |
| 2. 해시 | SHA-256 계산 | 새 파일·바뀐 파일 | 2 | 32GB, 기가비트 SMB 기준 5–10분 |
| 3. 추출 | 1–2쪽 텍스트, DOI 후보, 초록 후보 | 해시 완료 | 3 | 8천 × 0.5–1초 ÷ 3 ≈ 30–45분 |
| 4. 서지 확인 | 기존 work 대조 → DOI 묶음 조회 → 제목 검색 → 초록 보완 | 추출 완료 | OpenAlex 직렬 | DOI 묶음 약 100회, 제목 검색 약 3,500회. 30분 안팎 |
| 5. 연결 | work 갱신, `linked` 첨부, FTS 갱신 | 확인 완료 | 트랜잭션 | 짧음 |
| 6. 임베딩 | Ollama `/api/embed`에 32개씩 | 연결 완료 | 요청 1개씩 | 약 6분 (`latest` 실측 초당 22편. 25,000편이면 약 18분) |

1단계가 끝나면 폴더 트리와 목록을 바로 쓸 수 있다. 파일명에서 얻은 연도·저자·제목이 먼저 보이고, 서지와 초록은 뒤 단계가 진행되면서 채워진다. 2–6단계는 파이프라인으로 겹쳐 돈다. 첫 색인 전체는 대략 1시간으로 예상하며, 추출과 제목 검색이 대부분을 차지한다.

### 5.2 증분 스캔과 이동 감지

- 앱 시작 시, 설정의 `다시 스캔` 버튼, 그리고 앱이 켜져 있는 동안 30분마다 스캔한다. SMB에서는 FSEvents를 믿기 어려우므로 파일 감시는 쓰지 않는다.
- 크기와 mtime이 `hashed_*`와 같으면 해시를 다시 계산하지 않는다.
- 사라진 행과 새로 생긴 행 중 파일명과 크기가 같은 쌍은 이동으로 처리한다. `rel_path`, `folder_id`, 첨부 경로만 고친다. `intake.py`는 파일명을 유지하므로 대부분 이 규칙으로 잡힌다.
- 그 밖의 새 파일은 해시를 계산한 뒤, 사라진 행 중 해시가 같은 것이 있으면 이동(이름 변경)으로 처리한다.
- 남는 사라진 행은 `missing`으로 표시하고 `missing_since`를 남긴다. work와 임베딩은 지우지 않는다. 파일이 다시 나타나면 원래 상태로 돌아간다.
- 같은 해시의 파일이 두 곳에 있으면 같은 work를 가리키게 하고, 두 번째 파일은 `info.duplicateOf`로 표시한다.
- **오프라인 보호**: 루트가 없거나 디렉터리가 아니면 스캔을 중단하고 "서고 오프라인"으로 표시한다. 이때는 어떤 파일도 `missing`으로 바꾸지 않는다. 한 번의 스캔에서 20% 넘게 사라지면(마운트 일부 실패, 권한 문제) 자동 반영하지 않고 사용자 확인을 받는다.

### 5.3 추출

`src/workers/pdf.ts`에 `shelf` 모드를 추가한다. 1–2쪽 텍스트(최대 30,000자), PDF 메타데이터 제목, DOI 후보(최대 5개), 초록 후보를 돌려준다. 초록 후보는 "Abstract"나 "Summary" 표제 뒤부터 "Introduction", "Keywords", "1." 앞까지를 자르고, 300–3,000자일 때만 채택한다. 15초 시간 제한과 100MB 초과 파일 생략은 기존 규칙을 그대로 따른다.

### 5.4 서지 확인 규칙

입력은 파일명 파싱(연도, 첫 저자, 제목), PDF 메타데이터 제목, 본문 DOI 후보다. 사용자가 직접 정리한 파일명 제목을 가장 믿을 만한 제목 신호로 쓴다.

1. **해시 일치**: 앱이 이미 관리하는 첨부(현재 104개)와 해시가 같으면 그 work에 연결한다.
2. **DOI**: 후보 DOI를 모아 OpenAlex `filter=doi:a|b|…`로 50개씩 묶어 조회한다. OpenAlex 제목과 파일명 제목의 `titleSimilarity`가 0.5 이상인 DOI만 받는다. 1–2쪽에 인용 문헌 DOI가 함께 찍힌 경우(p1 캐시 기준 213건)를 걸러내기 위한 규칙이고, `matchesDownloadedPdf`와 같은 기준이다. 여러 개가 통과하면 유사도가 가장 높은 것을 고른다.
3. **제목 검색**: DOI로 못 찾으면 파일명 제목과 연도(±1)로 OpenAlex를 검색한다. 유사도 0.9 이상이고 첫 저자 성이 같으면 받는다. 0.75–0.9이거나 저자가 다르면 `review` 상태로 두고 후보 3개를 `info`에 저장한다.
4. **실패**: 파일명 기반 임시 work(`source: "shelf"`)를 그대로 둔다. 상태는 `provisional`이다.
5. **보충자료·정오표**: `isAuxiliaryPdf`에 걸리면 `auxiliary`로 표시한다. 목록에는 보이지만 임베딩과 추천에서는 뺀다.
6. **충돌**: `upsert`가 `IDENTITY_CONFLICT`를 던지면 그 파일만 `review`로 두고 다음 파일로 넘어간다.

임시 work의 서지가 확인되면, DOI가 이미 다른 work(예: 프로젝트 논문)에 있는 경우 그 work로 연결을 옮긴다. 그리고 임시 work가 다른 곳에서 참조되지 않으면 지운다. 그렇지 않은 경우에는 같은 ID에 확인된 서지를 덮어쓴다. 사용자가 수정한 필드(`edits`)는 기존 `upsert` 규칙대로 보존한다.

초록은 다음 순서로 채운다.

1. OpenAlex 초록 (`restoreAbstract`)
2. PMID가 있으면 PubMed `efetch` (200개씩 묶음)
3. PDF에서 뽑은 초록 후보 (`abstractSource: "pdf"`. UI에 "PDF에서 추출" 표시, 편집 가능)
4. 없으면 초록 없이 둔다. 임베딩은 제목과 1쪽 앞부분으로 대신한다(5.5 참조).

OpenAlex 일일 예산을 다 쓰면(`DAILY_BUDGET`) 서지 확인 단계만 멈추고 다음 날 이어서 한다. 나머지 단계와 열람은 계속 동작한다. 서고 색인은 탐색 실행의 40회 상한과 따로 집계한다.

### 5.5 임베딩

`src/service/providers/ollama-local.ts`

```ts
export class OllamaLocal {
  constructor(private base = () => "http://127.0.0.1:11434", private fetcher: FetchLike = fetch) {}
  status(signal?: AbortSignal): Promise<{ running: boolean; version?: string; models: { name: string; digest: string }[] }>;
  embed(model: string, inputs: string[], signal: AbortSignal): Promise<Float32Array[]>; // POST /api/embed
}
```

- `POST /api/embed`에 `{ model, input: string[], truncate: true, keep_alive: "10m" }`를 보낸다. 응답 벡터는 클라이언트에서 L2 정규화한다.
- 기본 주소는 loopback만 허용한다. 다른 호스트를 지정하면 "초록과 질의가 이 Mac 밖으로 나갑니다" 경고를 보여 준다.
- 모델이 없으면 설정 화면에 `ollama pull embeddinggemma-2:270m` 안내를 띄운다. 앱 안에서 내려받는 버튼(`/api/pull`, 약 378MB)은 사용자가 누를 때만 실행한다.

입력 텍스트와 프롬프트

```ts
// 형식은 EmbeddingGemma 1 기준의 가정이다. Phase 0에서 EmbeddingGemma 2 모델 카드로 확인한 뒤 고정한다.
export const EMBED_PROMPTS = {
  version: "eg2-v1",
  document: (title: string, text: string) => `title: ${title || "none"} | text: ${text}`,
  query: (q: string) => `task: search result | query: ${q}`,
};
```

| basis | 입력 | 조건 |
|---|---|---|
| `abstract` | 제목 + 초록 | OpenAlex·PubMed 초록이 있을 때 |
| `pdf-abstract` | 제목 + PDF에서 뽑은 초록 | 위가 없을 때 |
| `page1` | 제목 + 1쪽 앞 1,500자 (머리말·저널 표기 제거) | 초록이 없을 때 |
| `title` | 제목만 | 텍스트 추출 실패 |

- 저자와 학술지 이름은 넣지 않는다. 주제 유사도와 상관없는 신호라서다.
- `model`(태그 + digest), `prompt`, `text_hash` 가운데 하나라도 바뀌면 다시 임베딩한다. 서지를 고쳐 초록이 바뀐 work도 자동으로 다시 임베딩된다.
- 서비스 프로세스가 서고 벡터를 `Float32Array` 하나(N × 768)로 메모리에 올려 둔다. 벡터를 추가하거나 바꾸면 해당 행만 갱신한다.
- Ollama가 꺼져 있거나 모델이 없으면 임베딩 단계만 멈춘다. 열람과 어휘 검색은 그대로 동작한다.

## 6. 기능별 통합

### 6.1 서고 열람

사이드바 `문헌 탐색` 아래, `라이브러리` 위에 `서고` 구역을 둔다.

```
문헌 탐색
서고  Articles · 8,322        ● 색인 중 61% / 오프라인
  ▸ 수신함                99
  ▾ 01 Psychiatric Disorders  1,224
      ADHD & Autism        325
      …
  ▸ 02 Clinical Practice …    321
  ▸ 확인 필요              (review + provisional 수)
라이브러리
  내 아카이브 …
```

- `ShelfTree.tsx`는 `ArchiveTree`의 아이콘·이름·개수 열과 들여쓰기를 그대로 따른다. 도메인은 접고 펼 수 있고, 펼침 상태는 기존 UI 상태 저장에 넣는다.
- `수신함`은 루트 직속 PDF와 `_uncategorized`를 합친 것이다. `확인 필요`는 `review`와 `provisional` 파일을 모아 보여 주는 가상 폴더다.
- 폴더를 누르면 `list`의 새 범위 `scope: "shelf"`, `scopeId: <folderId>`로 목록을 연다. 도메인 폴더는 하위 폴더를 포함한다. 목록·그래프·연도 보기와 필터를 그대로 쓴다. 그래프의 인용선은 서고 논문끼리의 OpenAlex 인용 관계에서 나온다.
- 행에는 제목, 저자, 연도, 학술지와 함께 `확인 필요`, `초록 없음`, `PDF에서 추출한 초록`, `이 프로젝트에 저장됨` 배지를 붙인다.
- 논문을 누르면 기존 Inspector가 열린다. `초록` 탭은 그대로 쓰고, 상단에 서고 경로(폴더 칩), `PDF 열기`, `Finder에서 보기`, `프로젝트에 저장`을 더한다. `발견 근거` 탭에는 서지 판정 근거(DOI 일치, 제목 유사도, 후보 목록)를 보여 주고, `review` 파일은 여기서 후보를 고르거나 직접 수정한다.
- `PDF 열기`는 `ArticleReader`를 그대로 쓴다. 오프라인이면 버튼을 끄고 "NAS 연결 필요"를 표시한다.
- `프로젝트에 저장`은 기존 `mutateWorks(screening: "included")`를 호출한다. 첨부가 전역이라 서고 PDF는 프로젝트에서도 바로 열린다.

성능 작업도 이 단계에서 같이 한다.

- `Library.views(projectId, ids)`: 상태, 소주제, 첨부 수, 컬렉션을 `IN`/`json_each` 묶음 쿼리 4개로 가져온다. `list`가 이 함수를 쓰도록 바꾼다.
- `Library.edges(ids)`: `citing_id`를 `json_each(?)`로 거른 SQL로 바꿔 전체 스캔을 없앤다.
- `duplicates`: 전체 순회 대신 FTS 제목 검색으로 후보를 좁힌 다음 `titleSimilarity`를 적용한다.
- `hasValidPdf`: `shelfFileId`가 있는 첨부는 파일이 존재하고 크기·mtime이 `hashed_*`와 같으면 유효로 본다. 전체 해시 검증은 PDF를 열 때 한다(`PdfReader`가 이미 그렇게 한다).

### 6.2 관련 문헌 추천

Inspector에 `관련 문헌` 탭을 추가한다. 순서는 `초록 | 관련 문헌 | 발견 근거 | 노트`다.

- **비슷한 서고 논문**: 문서 벡터끼리 코사인 유사도 상위 10편. 자기 자신, 같은 해시의 사본, `auxiliary`는 뺀다. 행마다 유사도 막대, 폴더 칩, 연도를 보여 주고, 누르면 그 논문으로 이동한다. `다른 폴더만` 토글을 둔다. 다른 폴더에 정리해 둔 관련 논문을 찾을 때 가장 쓸모가 있어서다.
- **인용으로 이어진 서고 논문**: 이 논문이 인용한 서고 논문, 이 논문을 인용한 서고 논문. 로컬 `citations` 테이블만 쓰고 API는 부르지 않는다.
- **서고 밖 논문**(탐색 후보, 프로젝트 논문): 제목과 초록을 즉석에서 임베딩해(`embedding_cache`) 같은 목록을 보여 준다. 새로 찾은 논문과 비슷한 논문을 이미 몇 편 가지고 있는지 보면서 저장 여부를 정할 수 있다.
- 한쪽이라도 basis가 `page1`이나 `title`이면 "초록 없음 · 정확도 낮음"을 표시한다.
- 유사도 표시 하한은 Phase 0 측정 결과로 정한다. 그 전에는 상위 10편을 하한 없이 보여 준다.

### 6.3 서고 우선 검색

`src/service/shelf/search.ts`

```ts
shelfSearch(query: string, opts: { limit: number; folderIds?: string[] }): Promise<{
  hits: { workId: string; score: number; lexicalRank: number | null; semanticRank: number | null; folderId: string }[];
  semantic: boolean; // Ollama를 썼는지
}>;
```

- DOI, PMID, OpenAlex ID 질의는 `identifiers`에서 바로 찾는다.
- 그 밖의 질의는 FTS5 상위 100편(bm25 가중치: 제목 3, 저자 2, 초록 1)과 벡터 상위 100편을 RRF(k=60)로 합친다. 벡터 쪽은 query 프롬프트로 질의를 임베딩한다.
- 결과는 질의 1회에 300ms 이내(Ollama 모델이 메모리에 있을 때)를 목표로 한다.

검색 실행과의 연결 (`discovery/engine.ts`)

- `search` 모드에 새 작업 종류 `{ kind: "shelf" }`를 추가하고 OpenAlex 작업보다 먼저 실행한다. API를 부르지 않으므로 40회 상한에 넣지 않는다.
- 서고 결과는 기존 `candidate()`로 후보에 넣는다. `relation: "shelf"`, `origins: ["내 서고"]`, `evidence.shelf`를 붙인다. 다른 검색 결과처럼 검토 대기함에 들어가고, 다음 새 검색에서 비워진다.
- 결과 화면 맨 위에 `내 서고에서 찾음 N편` 묶음을 고정한다(접기 가능). 점수를 부풀려 외부 결과와 섞지 않고, `relation`으로 따로 묶는다.
- OpenAlex 결과가 서고 work와 같은 ID로 합쳐졌으면(식별자 통합) `서고` 배지와 폴더 이름을 붙인다. 서고 쪽 work가 아직 `provisional`이라 합쳐지지 않았으면 제목·연도 규칙으로 "서고에 같은 제목" 힌트를 보여 준다.
- 필터에 `서고 보유: 전체 / 숨기기 / 만 보기`를 추가한다(`filterReasons`에 반영). `관련 논문`, `참고문헌`, `후속 인용` 탐색 결과에도 같은 배지와 필터가 적용된다.
- `DiscoveryMenu`에 `서고만 검색`을 추가한다. 네트워크 없이 동작한다.
- `ai` 모드는 연구 질문으로 서고 검색 결과를 후보에 먼저 넣는다(Phase 3 후반, 선택).

### 6.4 재다운로드 방지

- 식별자로 합쳐진 work는 서고 첨부가 이미 붙어 있다. 그래서 `PDF 원문 찾기`의 미리보기와 작업이 그 논문을 `기존`으로 건너뛴다. 6.1의 `hasValidPdf` fast path 덕분에 SMB를 다시 읽지 않는다.
- 합쳐지지 않은 경우를 위해 `matchShelf(work)`를 만든다. 색인에 저장된 서고 파일의 DOI 후보, 파일명 제목·연도·첫 저자에 `matchesDownloadedPdf`와 같은 규칙을 적용한다. 후보가 하나뿐이면 다운로드 없이 연결하고, 여러 개면 직접 확인하도록 목록에 남긴다.
- 원문 확보 미리보기에 `서고에서 찾음 N편 · 다운로드 없이 연결` 줄을 추가한다. 작업 실행 중에도 각 항목을 네트워크로 받기 전에 서고를 다시 확인한다.
- `MissingPdfList`에 `서고에서 연결` 동작을 추가한다. 기존 `다운로드한 PDF 폴더 연결`(`pdfMatch`)은 서고 밖 폴더용으로 남긴다.
- 서고 색인이 프로젝트 논문과 강한 식별자(DOI, PMID, OpenAlex ID, 해시)로 일치하면 자동으로 연결된다. 제목만 일치하면 자동 연결하지 않고 `서고 PDF 연결 후보`로 보여 준다.

### 6.5 AI 대화 근거

- 대화의 검색 옵션을 켜면 서고 검색 결과 상위 3편의 초록을 OpenAlex·PubMed 결과보다 먼저 근거로 넣는다.
- `ChatSource`에 `source: "shelf"`와 `workId`를 추가하고 `url`을 선택 필드로 바꾼다. 지금은 `safeWebUrl` 필터가 URL 없는 근거를 버리므로 이 경로도 함께 고친다. 근거를 누르면 앱 안에서 해당 논문을 연다.
- 대화에는 초록만 보낸다. PDF 본문은 지금처럼 사용자가 원문 화면에서 대화할 때만 보낸다.

### 6.6 설정

`Settings`에 `서고` 구역을 추가한다.

- 서고 위치(폴더 선택, 기본 제안 `/Volumes/LIBRARY/Articles`)와 제외 폴더 목록
- Ollama 상태: 실행 여부, 버전, 모델 설치 여부와 digest, 모델 태그 선택
- 색인 현황: 전체, 단계별, `ok`/`review`/`provisional`/`failed`/`missing` 수, 마지막 스캔 시각
- `다시 스캔`, `일시정지/재개`, `실패 항목 재시도`, `임베딩 다시 만들기`
- 실패 목록(파일별 사유)과 `확인 필요` 폴더로 가는 링크

## 7. 파일별 변경 목록

| 파일 | 변경 |
|---|---|
| `src/service/shelf/scanner.ts` (신규) | 폴더 순회, 파일명 파싱, 이동·사라짐 판정, 오프라인 보호 |
| `src/service/shelf/resolver.ts` (신규) | 5.4 규칙, OpenAlex·PubMed 묶음 조회, `raw` 축약 |
| `src/service/shelf/indexer.ts` (신규) | 단계 실행, 동시성, 일시정지·재개, 진행 이벤트 |
| `src/service/shelf/vectors.ts` (신규) | `work_embeddings` 입출력, 메모리 행렬, top-k |
| `src/service/shelf/search.ts` (신규) | FTS5 + 벡터 RRF, 식별자 질의, `matchShelf` |
| `src/service/providers/ollama-local.ts` (신규) | `status`, `embed`, `pull` |
| `src/shared/shelf.ts` (신규) | 서고 타입과 상수(`EMBED_PROMPTS`, 기본 제외 폴더) |
| `src/service/db/database.ts` | schema 3, `scope: "shelf"`, `views()` 묶음 조회, `edges()` SQL 필터 |
| `src/service/db/trash.ts`, `src/service/db/merge.ts` | 서고 참조 보존, 새 테이블 이관 |
| `src/workers/pdf.ts` | `shelf` 추출 모드 |
| `src/service/interchange/pdf.ts` | `hasValidPdf` fast path |
| `src/service/fulltext/jobs.ts` | 다운로드 전 서고 확인, 미리보기 집계 |
| `src/service/discovery/engine.ts` | `shelf` 작업, 서고 배지 |
| `src/service/chat/search.ts`, `src/shared/chat.ts` | 서고 근거 |
| `src/service/service.ts` | 명령 추가, `busy()`에 색인 포함(색인은 탐색을 막지 않되 병합·영구 삭제는 막는다) |
| `src/shared/types.ts`, `src/shared/contracts.ts`, `src/shared/rpc.ts` | 타입, 계약, 브리지 |
| `src/shared/domain.ts` | `filterReasons`에 `shelf` 필터 |
| `src/renderer/components/ShelfTree.tsx` (신규) | 사이드바 서고 트리 |
| `src/renderer/components/RelatedShelf.tsx` (신규) | Inspector `관련 문헌` 탭 |
| `src/renderer/components/Inspector.tsx` | 탭 추가, 서고 경로·동작, 판정 근거 |
| `src/renderer/App.tsx` | 서고 범위, 고정 묶음, 오프라인 배너 |
| `src/renderer/components/Settings.tsx`, `Filters.tsx`, `DiscoveryMenu.tsx`, `MissingPdfList.tsx`, `DownloadDialog.tsx` | 6.3–6.6 UI |

새 RPC 명령

| 명령 | 입력 | 출력 |
|---|---|---|
| `shelfStatus` | – | 루트, 단계·상태별 수, 작업 상태, Ollama 상태, 오프라인 여부 |
| `shelfConfigure` | 경로, 제외 폴더, 모델 | 설정 |
| `shelfScan` / `shelfControl` | `pause`·`resume`·`cancel`·`retryFailed`·`reembed` | – |
| `shelfTree` | – | 폴더 트리와 개수 |
| `list` (확장) | `scope: "shelf"`, `scopeId: folderId` | 기존 `ListResult` |
| `shelfRelated` | `projectId`, `workId`, `limit`, `otherFoldersOnly` | 유사 논문, 인용 연결 |
| `shelfSearch` | `projectId`, `query`, `limit` | 검색 결과 |
| `shelfReview` / `shelfResolve` | 파일 ID, 후보 선택 또는 직접 입력 | 확인 결과 |
| `shelfReveal` | 파일 ID | Finder에서 보기 |

## 8. 단계별 일정

### Phase 0 · 확인 (1–2일)

실제 서고와 모델로 수치를 잰 다음 설계값을 확정한다. 결과는 `docs/shelf-spike.md`에 남긴다.

- EmbeddingGemma 2의 문서·질의 접두어 형식을 Google 모델 카드에서 확인한다. `270m`과 `latest`의 텍스트 임베딩이 같은지 비교한다. 같으면 `270m`을 쓴다.
- 처리량 (측정 완료, 2026-10-11, M2 Max, `embeddinggemma-2:latest`): 실제 1쪽 텍스트 1,500자 256개 기준 묶음 16개 22.3편/초, 32개 22.7편/초, 64개 19.7편/초. 묶음 크기는 32로 한다. 첫 호출(모델 적재) 2.7초, 이후 질의 1개 p50 27ms, p95 55ms. `270m` 태그가 더 빠른지는 아직 재지 않았다.
- SMB 측정: 300편 폴더 하나에서 stat 순회 시간, 해시 MB/s, 동시성 1/2/3일 때 파일당 추출 시간.
- 서지 확인 표본: 11개 도메인에서 200편을 고르게 뽑아 DOI 채택률, 제목 검색 채택률, 오매칭 수(50편 수동 확인), 초록 확보율(OpenAlex/PubMed/PDF)을 잰다.
- 임베딩 품질 대리 지표: 사용자가 직접 만든 폴더 분류를 정답으로 보고, 상위 10개 이웃 중 같은 말단 폴더 비율(폴더 일치율@10)을 잰다. basis(초록, 1쪽, 제목)별, 차원(768, 256)별, 그리고 기존 `tfidf-topic-v1` 대비로 비교한다. 질의 30개를 직접 판정한 소규모 검색 평가도 만든다. 이 결과로 유사도 표시 하한을 정한다.
- `raw`를 줄였을 때 work 한 편의 크기를 잰다.

통과 기준: 위 수치를 기록하고, 12장의 결정 사항을 확정한다.

### Phase 1 · 서고 색인과 열람 (0.3.0)

- schema 3과 마이그레이션, 삭제·병합 보완
- 스캐너, 해시, 추출, 서지 확인, 임시 work, `linked` 첨부, FTS
- 성능 수정: `views()`, `edges()`, `duplicates`, `hasValidPdf` fast path
- UI: 사이드바 서고 트리, `scope: "shelf"` 목록, Inspector 서고 동작과 판정 근거, 원문 보기, 오프라인 배너, 설정의 서고 구역

통과 기준: 8,322편 색인이 중단·재시작을 거쳐도 완료된다. 바뀐 것이 없을 때 재스캔은 60초 이내이고 외부 API를 0회 부른다. 400편 폴더 목록은 300ms 이내, 서고 전체 목록은 1.5초 이내로 열린다. 서고 디렉터리의 파일 목록, 크기, mtime이 색인 전후로 같다.

### Phase 2 · 임베딩과 관련 문헌 (0.3.1)

- `OllamaLocal`, 임베딩 단계, 메모리 행렬, 재임베딩 정책
- Inspector `관련 문헌` 탭(유사 논문, 인용 연결), 서고 밖 논문의 즉석 임베딩

통과 기준: 탭이 150ms 이내에 열린다. 폴더 일치율@10이 Phase 0에서 고른 설정의 측정값과 같다. Ollama를 끈 상태에서도 열람과 어휘 검색이 동작한다.

### Phase 3 · 서고 우선 검색과 재다운로드 방지 (0.3.2)

- 하이브리드 검색, 검색 실행의 `shelf` 작업, 고정 묶음, 배지, 필터, `서고만 검색`
- 원문 확보의 서고 확인, `서고에서 연결`
- AI 대화의 서고 근거

통과 기준: 서고에 있는 논문의 제목, DOI, 한국어로 쓴 주제 질의가 결과 맨 위 묶음에 나온다. 원문 확보 미리보기가 서고에서 연결할 편수를 보여 주고, 해당 논문에는 네트워크 요청을 보내지 않는다.

### Phase 4 · 후속 (선택)

- `확인 필요` 처리 화면 개선(일괄 승인, 키보드 처리)
- 중복 의심 보고: 같은 DOI이거나 임베딩 유사도 0.98 이상. `_duplicated` 폴더 운영 보조
- 수신함 논문의 폴더 제안: 이웃 폴더 투표로 후보를 내고 `intake.py apply` 형식으로 복사만 해 준다. 파일은 옮기지 않는다
- 앱이 내려받은 PDF를 서고 수신함(루트)에 `연도 - 저자 - 제목.pdf` 이름으로 복사하는 기능. 사용자가 누를 때만 동작하며, 읽기 전용 원칙의 유일한 예외다
- 오프라인 읽기용 로컬 사본, `_system/p1.jsonl`을 첫 색인 가속 캐시로 쓰기, `_summaries/*.md`를 노트로 연결
- 프로젝트 아카이브 안의 의미 검색과 소주제 분류 보조, 서고 지도 시각화

## 9. 검증 계획

통합 테스트(`tests/integration/shelf-*.test.ts`)

- 준비물: 임시 디렉터리에 만든 서고 fixture(`tests/fixtures/synthetic-local.pdf` 변형, 2단계 폴더, 루트 수신함), OpenAlex·PubMed 가짜 fetcher, 해시에서 결정적 벡터를 만드는 가짜 Ollama 서버(`Bun.serve`, 임의 포트)
- 스캔: 신규·변경·이동(이름 유지, 이름 변경)·사라짐·복귀, 같은 해시 사본, 제외 폴더
- 오프라인: 루트 없음, 20% 이상 사라짐 확인 요구, 이 경우 `missing` 표시 없음
- 서지 확인: DOI 채택, 인용 문헌 DOI 함정, 제목 검색 채택·보류, 저자 불일치, 보충자료, 식별자 충돌, 임시 work의 서지 확정, 기존 프로젝트 work로 합치기
- 초록: OpenAlex → PubMed → PDF 순서, `abstractSource` 표시
- 임베딩: 모델·프롬프트·텍스트 변경 시 재임베딩, Ollama 중단과 재개, 오류 응답
- 검색: 식별자 질의, RRF 순서 결정성, Ollama 없을 때 어휘 검색만
- 탐색 연동: `shelf` 작업의 후보와 고정 묶음, 서고 배지, 필터, 40회 상한 미포함
- 재다운로드 방지: 미리보기 집계, 다운로드 생략, 모호한 후보 미연결
- 기존 기능 보존: 영구 삭제가 서고 work를 지우지 않음, 병합과 되돌리기, 백업·복원(schema 2 백업 포함), 프로젝트 저장 후 원문 보기
- 읽기 전용 보장: 전체 색인 전후로 fixture 디렉터리의 파일 목록, 크기, mtime 비교

성능 테스트(`tests/integration/performance.ts` 확장): 서고 work 1만 편과 인용 50만 행을 합성해 목록, `edges`, 검색, 관련 문헌의 지연 예산을 확인한다.

실제 환경 확인

- `scripts/live-smoke.mjs`: 로컬 Ollama가 있으면 실제 `/api/embed` 호출을 확인한다.
- 실제 서고 QA는 `RESEARCHBUNNY_BUILD_QA_ROOT`로 만든 QA 앱과 별도 데이터 디렉터리에서 한다. 설치 앱을 바꾸기 전에는 이전처럼 `app-backups/`에 앱과 DB 스냅샷을 남긴다.
- 기존 필수 검증(`typecheck`, `lint`, 전체 통합 테스트, `test:desktop`)을 그대로 통과해야 한다.

## 10. 위험과 대응

| 위험 | 대응 |
|---|---|
| NAS 미연결·SMB 지연 | 오프라인 보호(5.2), 서지·초록·추천은 DB만으로 동작, 해시 재계산 최소화 |
| `intake.py` 작업 중 스캔 | 파일명·크기 기반 이동 감지, 사라짐은 다음 스캔에서 확정, 대량 사라짐 확인 |
| 본문의 인용 문헌 DOI 오채택 | 파일명 제목과 유사도 0.5 이상 요구(5.4) |
| OpenAlex 초록 누락 | PubMed, PDF 추출 순으로 보완하고 출처 표시 |
| OpenAlex 일일 예산 | 서지 확인 단계만 일시정지, 다음 날 재개 |
| 임베딩 모델 교체 | 모델 digest 기록, 자동 재임베딩(270m 기준 수 분) |
| 프롬프트 형식 오해 | Phase 0에서 확인, `prompt` 버전으로 재임베딩 |
| DB 크기 증가 | `raw` 축약, 축약 사본만 스냅샷에 저장, Phase 0에서 측정 |
| 기존 화면 성능 저하 | `views()`, `edges()`, `duplicates` 수정을 Phase 1에 포함, 성능 테스트 |
| schema 3 이후 이전 앱 실행 불가 | 설치 전 앱·DB 백업, schema 2 백업 복원 테스트 |
| 개인정보 | 임베딩과 질의는 로컬 처리, loopback 이외 Ollama 주소는 경고, 외부로는 DOI·제목만 |

## 11. 범위 밖

- 서고 파일의 이동, 이름 변경, 삭제, 분류 체계(`taxonomy.json`) 편집
- 스캔 PDF의 OCR (텍스트 없는 PDF 10건)
- PDF 본문 전체를 청크로 나눈 임베딩과 본문 RAG. 이번 범위는 초록 단위다
- 그림·이미지 임베딩(`latest` 태그의 이미지 인코더)
- 여러 기기 간 색인 동기화, 외부 벡터 DB

## 12. 결정이 필요한 사항

| 항목 | 제안 | 이유 |
|---|---|---|
| UI 이름 | "서고" | "아카이브"는 이미 프로젝트 저장 문헌을 뜻한다 |
| 임베딩 모델 태그 | 설치된 `latest`로 시작 | 초당 22편이면 첫 색인 6분이라 충분하다. `270m`(텍스트 전용, 378MB)이 더 빠르고 텍스트 임베딩이 같다면 Phase 0에서 바꾼다. 바꾸면 digest가 달라져 전체가 자동으로 다시 임베딩된다 |
| `_duplicated` 폴더 | 기본 제외 | 사본이 추천과 검색 결과를 중복으로 채운다 |
| 기존 프로젝트 논문에 서고 PDF 자동 연결 | 강한 식별자 일치일 때만 자동, 제목 일치는 제안만 | 기존 폴더 연결 규칙과 같은 기준 |
| 검색 시 서고 결과를 검토 대기함 후보로 넣기 | 넣는다 | 기존 검색 결과와 같은 저장·선택·그래프 흐름을 그대로 쓸 수 있다 |
| 앱이 받은 PDF를 서고 수신함에 복사 | Phase 4에서 사용자가 누를 때만 | 다음 재다운로드를 막는 마지막 고리지만, 읽기 전용 원칙의 예외라 따로 동의를 받는다 |
