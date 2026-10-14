# ResearchBunny 0.3.6 · 2026-10-14

## Changes

- **A research question no longer fails related searches.** A related search starts with the seed's research question as an OpenAlex keyword search. OpenAlex reads `*` and `?` as wildcards and rejects them in its default keyword search with a 400. A question ending in "?" therefore failed every related search on its first call with `OpenAlex 요청 실패 (400). 검색 조건을 확인하세요.`. None of the remaining tasks ran, and `재개` repeated the same request. Keyword searches now drop those two characters.
- **The research question becomes English OpenAlex queries.** Without the "?", a question written as Korean prose still matched nothing, because OpenAlex searches English keywords. The question also did little for ranking, since its Korean words never appear in English abstracts.
  - **Saving the seed.** When the question is new or has no queries yet, the AI writes up to 5 English keyword queries and keeps them with the seed. Saving the same question again keeps them. If the AI call fails, the seed is still saved, and the toast says the queries will be written on the next related search.
  - **The dialog.** `초기 관심 기준 변경` shows the queries under the question in `OpenAlex 검색어 (영어 · 한 줄에 하나)`. `질문에서 만들기` writes them on demand, and queries the user edits are saved as written. Editing the question clears queries the user has not edited, so they are written again on save.
  - **Related searches.** `초기 관심 검색` runs the first 3 queries. That is up to 3 of the run's 40 calls and 30 OpenAlex credits, where it used to be 1 call and 10 credits. A seed saved before 0.3.6 gets its queries on its first related search. Without queries (AI off or failing), the search uses the first seed's title and never the question itself. A failed AI call is noted in the run's closing message.
  - **Ranking.** Relevance is scored against the queries instead of the question when the seed has them.
- This is also the first installed build with 0.3.5 and two fixes merged after 0.3.4:
  - Pinned run groups (seed papers and shelf hits) get their own `모두 선택` checkbox, and the run's rank order is labelled `관련도순`.
  - The inspector empties once its paper leaves the list.

Library schema stays at 3. Queries are an optional field in the seed profile, and an older app ignores them.

## Validation

- Reproduced the failure against the live OpenAlex API with the exact question: 400 with the wildcard error. Without the "?" the same request returns 200 with 0 results.
- Typecheck and lint passed. Integration suite: **206 passed, zero failed** across 23 files.
- New tests:
  - A keyword search sent through the provider drops `*` and `?`. A semantic search keeps them.
  - A related search with a Korean question asks the model once, searches the returned queries, stores them on the same seed version, and gives a paper sharing words only with the queries a relevance score above 0. A second run does not ask again.
  - With the model failing, switched off, or absent, the initial search uses the seed title, the question is never searched, and that paper scores 0. Only the failing model is noted in the run message.
  - Saving through the service writes queries once per question, keeps them for the same question, keeps the user's own (trimmed and de-duplicated), and still saves the seed when the model fails.
- The real renderer was run against a scratch library with a stubbed model and a seed saved without queries:
  - The dialog opened with the Korean question and an empty query field.
  - `질문에서 만들기` filled in the 3 queries.
  - Saving showed `검색어 만드는 중…` and stored the queries, which the dialog showed when reopened.
  - Editing the question cleared them.
- Packaged app: strict signature verification passed, and the packaged smoke test passed (PDF reader, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion with a restricted PATH).

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261014-211733-seed-queries-0.3.6` (integrity ok, schema 3, **12,296 works**, **8,556 attachments**, **8,562 shelf files**, 6 projects, matching the live library). The replaced 0.3.4 bundle is kept there as `ResearchBunny-0.3.4-installed.app`.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.6**; all **441 files** match the package and strict signature verification passed. 0.3.5 was never installed, so this is also its first install.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.3.6/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
