# ResearchBunny 0.3.19 · 2026-10-28

## Changes

- **Paper rows shrink when the window widens.** The app opens with a narrow window, so long titles wrapped onto several lines; after the window was widened the rows kept that height and showed a large empty band under each paper. WebKit does not recompute a grid row's `auto` track when the row gets wider. Rows now size their track with `grid-auto-rows: min-content`, so they follow their content in both directions.
- **The shelf search no longer runs again and again.** Since 0.3.18, progress from the body text index reached the list as a change, so every shelf scan was followed by the search running again: the status bar alternated with "서고에서 찾는 중…" while the results stayed the same. Only 설정 → 서고 → 본문 색인 listens to that progress now.
- **A new launch starts with empty search boxes.** Each folder and view remembered its search words, and they came back after quitting and reopening the app. The first time a project opens after launch, its views drop the last session's search words and result page; the folder, selected papers, view mode and sort stay. Within a session, moving between folders still keeps each one's search.

Library schema stays at 3.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **294 passed, 0 failed** across 35 files, including the navigation test extended for dropping search words at launch (place, selection and discovery query kept, the saved history untouched).
- Row heights in the system WebKit (an offscreen `WKWebView` loading the browser harness): at 820 px rows were 209, 187 and 139 px; widened to 1700 px they kept those heights around 66 px of content before the fix, and dropped to 96 px (the minimum) after it; narrowed again they grew to fit their content.
- Browser harness (scratch library, the real React UI and service, local Ollama): reopening the page restored the archive view with an empty search box; with a shelf search open, a body text pass over a newly added PDF sent its progress without reloading the list (two list loads, both from the paper being added).
- Packaged app: the DMG's checksum is valid and strict signature verification passed for the DMG's app and for the bundle inside the `.tar.zst` (both 0.3.19). The packaged smoke test passed on the extracted bundle with a restricted PATH (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion). The packaged renderer contains `grid-auto-rows:min-content` for paper rows, the event filter that skips `passages`, and the launch-time search reset.
- Not checked: the installed app's own window.

## Known issues

- The first passage search after launch takes about 2.5 s while the in-memory sign bits load, and the service does not answer other requests during that time.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261028-201628-steady-lists-0.3.19` (integrity ok, schema 3, **12,323 works**, **9,184 attachments**, **9,219 shelf files**, 6 projects, matching the live library). The replaced 0.3.18 bundle is kept there as `ResearchBunny-0.3.18-installed.app` (signature verified). `passages.sqlite` was not copied again: 0.3.18 had already continued it to **9,164 PDFs and 422,719 passages**, all embedded, and the 0.3.18 backup holds a clone from before.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.19** (bundle hash `3i88ye1mzx1fc`); all **242 files** match the package and strict signature verification passed. The app was not running and was not launched.

Artifacts, built from main at `aaae2d8` (PR #3): `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` (SHA-256 `faa2a478…0025bedf`) and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst` (`77df929c…2ff1616`), also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.19/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
