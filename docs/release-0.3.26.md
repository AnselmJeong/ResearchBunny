# ResearchBunny 0.3.26 · 2026-10-31

## Changes

- **A genealogy report now says when it is done.** Before, a run that ended at the render step only left `렌더 · 완료` on the job line, so you found out when you opened the files. Now any run that ends with a render (`이어서 진행`, `렌더만 실행`, `EPUB·PDF 만들기`) announces it once.
  - The report's workspace opens a `계보 리포트를 완성했습니다` dialog. It shows sections written, works cited, the check result (open items, or `실행하지 않음` if checks never ran), this run's time and AI calls, and any render errors. Its buttons are `검증 결과 보기` (only when items are open), `작업 폴더`, `EPUB 열기` and `PDF 열기` (`Markdown 열기` when there is no PDF).
  - On another screen of the app, the same summary shows as a toast at the bottom.
  - The app also sends a macOS notification, for when ResearchBunny is in the background.
  - Runs that fail, pause or are cancelled announce nothing, and neither do runs that stop before the render step. The job line of a completed run now has a green background.
  - Render results (`outputs`) also keep the number of cited works.
- **답변 citation numbers fit the line again.** The number chips after each sentence took the 30px minimum height of every button and stood taller than the text. They are 16px tall again.

Library schema stays at 3. Nothing in the library changes on install.

## Validation

- `genealogy-write.test.ts`: a run written to the end sends one finished notice with the title, the number of cited works and the check result. A run that stops on a section the safeguards refuse sends none.
- QA in the browser pane against a scratch copy of a QA library (not the real library). A seeded three-section report was rendered with `렌더만 실행`. The dialog appeared with 3/3절, 인용 문헌 3편, 확인할 항목 1개 and 1분 미만. `검증 결과 보기` opened the 검증·내보내기 tab. Starting `EPUB·PDF 만들기` and moving to 문헌 탐색 showed the toast. Open-file buttons were not pressed, so no other app came forward.
- A citation chip with the 답변 markup measured 16px against a 25px line; with the old rule it measured 30px.
- Typecheck and lint passed. Integration suite on macOS after a full build: **313 passed, 0 failed** across 35 files.
- Packaged app: the DMG's checksum is valid and strict signature verification passed for the DMG's app and for the bundle inside the `.tar.zst` (0.3.26, bundle hash `tx6ae2d7z814`, 242 files). The packaged smoke test passed on the extracted bundle with a restricted PATH. The bundle's stylesheet has the completion dialog styles and the chip's `min-height: 0`.
- Not checked: the macOS notification in the packaged app, and a citation chip in a real 답변.

## Known issues

- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261031-104251-finished-notice-0.3.26` (integrity ok, schema 3, **12,500 works**, **9,308 attachments**, **9,345 shelf files**, 7 projects, **44 written genealogy sections**, matching the live library). The replaced 0.3.25 bundle is kept there as `ResearchBunny-0.3.25-installed.app` (signature verified).
- Replaced `/Applications/ResearchBunny.app` with version **0.3.26** (bundle hash `tx6ae2d7z814`); all **242 files** match the package and strict signature verification passed. The app was not running; it was not launched afterwards.

Artifacts, built from `65bb0d1`: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` (SHA-256 `5f649e84…93570bc4`) and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst` (`994b2039…1178827c`), also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.26/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
