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

## Known issues

- The first passage search after launch takes about 2.5 s while the in-memory sign bits load, and the service does not answer other requests during that time.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
