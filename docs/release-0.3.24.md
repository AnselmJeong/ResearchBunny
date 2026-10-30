# ResearchBunny 0.3.24 · 2026-10-30

## Changes

- **답변: shelf questions answered from passages, with checked citations.** Shelf search gains a third view beside the paper list and `본문 구절`. Type a question in the search box and pick `답변`.
  - The connected AI (설정 → AI 연결) turns the question into two to four English search queries. Passages are found for the question and each query and fused by rank. Up to 20 of them, three per paper, sized to the AI input limit, go to the AI numbered with author, year, title, section and page. Asked from a folder, only that folder's papers are searched.
  - The AI writes Korean statements, each citing passage numbers with a verbatim 8–40-word quote, and says when the passages are not enough and what is missing.
  - The app keeps a citation only when its quote is in the passage (case, width, dashes, quotes and spacing folded; ellipsis pieces in order), renumbers citations by first use, and flags numbers that no cited passage holds.
  - In the view, a citation number jumps to the passage below with the quote highlighted; a statement whose citation could not be checked is muted with a dotted underline and ⚠. Below the answer: citations used, passages reviewed, citations dropped, the queries, the AI and the time taken, and `다시 답하기`.
  - The last 20 answers per question, scope, index state and AI setting are kept, so switching views does not call the AI again. Changing the view or the question cancels a running request. Asking takes two calls through the same path, settings and limits as `수신함 정리`.
  - Details: [본문 구절 기록](passages.md).
- **Genealogy report stages follow the models chosen in Settings.** Each stage's model in a genealogy report (유형·후보 판정, 문헌 카드, 가지 장부·목차·집필) used to be a text field prefilled with a copy of the Settings model. It is now a dropdown.
  - Its first choice, **`설정에 따름 · <model>`**, reads the model 설정 → AI 연결 names for that connection at every call, so changing Settings changes the report too.
  - The other choices list the account's Codex models, Claude's Opus, Sonnet and Haiku, or the Ollama Cloud models the saved key returns. A value no longer in the list stays, marked `· 목록에 없음`.
  - New reports start on 설정에 따름 for all three stages, on the Settings connection (Codex when Settings uses the paid OpenAI API).
  - Reports made earlier had copied the Settings model. When the app opens, a copy that still equals the Settings model becomes 설정에 따름; a stage set to another model keeps it.
  - An Ollama Cloud stage with no model of its own and none in Settings stops before the call and says where to choose one.

Library schema stays at 3.

## Validation

- Typecheck and lint passed on the merged code. Integration suite on macOS, after a full build: **308 passed, 0 failed** across 35 files. Before the merge, the genealogy change alone passed 306 of 306 twice in a row; a first run of it right after a build reported 2 failures whose names were lost to an output filter and did not come back.
- `passages.test.ts`: quote folding, ellipsis pieces in order and paraphrases, picking numbers, and with a stand-in AI the use of the queries, passage numbering and three per paper, citation checks and renumbering, unsupported numbers, progress events, kept answers and `fresh`, a malformed plan, insufficient passages and cancelling.
- The 답변 view was checked on the real shelf with Codex before this merge, read-only: three questions took 32–35 s each and cited 5–6 of 20 passages, with no quote dropped.
- `genealogy-llm.test.ts`: a route without a model uses the model Settings names at the time of each call (and a changed Settings model at the next call), an explicit model wins, and an Ollama stage with no model anywhere stops with `OLLAMA_MODEL`. `genealogy-prepare.test.ts`: an earlier report's copied models that match Settings switch to 설정에 따름 and a different choice stays.
- Browser harness (scratch library with the real React UI and service): the create dialog shows `설정에 따름 · deepseek-v4.1-flash:1017` for the Ollama stages and `설정에 따름 · Opus` with Opus, Sonnet and Haiku after switching a stage to Claude. The scratch library has no Ollama key, so the Ollama model list itself was not seen.
- Packaged app: the DMG's checksum is valid and strict signature verification passed for the DMG's app and for the bundle inside the `.tar.zst` (0.3.24, bundle hash `2k5x44dcm22xe`). The packaged smoke test passed on the extracted bundle with a restricted PATH. The service contains `passageAsk` and the renderer contains `다시 답하기` and `설정에 따름`.
- Not checked: the Codex and Ollama model lists with the real accounts, and the installed app's own window.

## Known issues

- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

## Installation

- Not installed. The app was running; `/Applications/ResearchBunny.app` is still 0.3.23.

Artifacts, built from `c543b1d` (main with `claude/researchbunny-rag-implementation-1a35c2` merged): `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` (SHA-256 `4dbe28af…df325934`) and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst` (`8bc4f9a0…89fa4467`), also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.24/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
