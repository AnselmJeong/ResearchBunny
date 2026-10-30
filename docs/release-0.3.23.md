# ResearchBunny 0.3.23 · 2026-10-30

## Changes

- **`수신함` counts its PDFs, as `수신함 정리` does.** The sidebar number used to count papers in the root folder, minus papers in the open project's trash, so it disagreed with the number of files `수신함 정리` offered to sort (64 against 72 on the real shelf). It now counts the root folder's PDFs that are on disk and not hidden, the same rule `수신함 정리` uses, for every project. Of the 8 the real shelf was missing, 1 was a second file of the same paper (Gluck et al. 2025) and 7 were papers in one project's trash whose PDFs still sat in the inbox.
- **The inbox lists papers that are in this project's trash.** They still have a PDF waiting to be sorted, so the inbox shows them, marked `이 프로젝트 휴지통에 있음`, and its list matches its count again. Other shelf folders still leave this project's trashed papers out of their lists and counts.
- The inbox heading still counts papers. When the inbox holds more PDFs than papers (a second copy of a paper, or a PDF still being indexed), it adds `PDF N개` beside the count. It shows only when no search or filter narrows the list.

Library schema stays at 3.

## Validation

- Typecheck and lint passed. Integration suite on macOS, after a full build: **304 passed, 0 failed** across 35 files.
- `shelf.test.ts`: on a scratch shelf, the sidebar count and the `수신함 정리` count are equal, and a paper trashed in this project keeps both and stays listed with its trash state. A second copy of a paper adds one PDF to both counts and no paper to the list. The deletion test now expects the inbox to keep counting a trashed paper's PDF.
- Read-only check of the real library: the root folder holds 72 PDFs on disk and 74 index rows, 2 of them missing; 71 papers; 7 of them in the trash of `Self-Reparing Mechanism and NIBS`.
- Packaged app: the DMG's checksum is valid and strict signature verification passed for the bundle inside the `.tar.zst` (0.3.23). The packaged smoke test passed on the extracted bundle with a restricted PATH. The renderer contains `이 프로젝트 휴지통에 있음`.
- Not checked: the real shelf in the new build and the installed app's own window.

## Known issues

- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261030-213807-inbox-count-0.3.23` (integrity ok, schema 3, **12,475 works**, **9,291 attachments**, **9,328 shelf files**, 7 projects, matching the live library). The replaced 0.3.22 bundle is kept there as `ResearchBunny-0.3.22-installed.app` (signature verified, identical to what was installed).
- Replaced `/Applications/ResearchBunny.app` with version **0.3.23** (bundle hash `2jvx66moq06ei`); all **242 files** match the package and strict signature verification passed. The user quit the running app first; it was not launched afterwards.

Artifacts, built from `16f9310`: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` (SHA-256 `30eca7fd…0acfc0fd`) and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst` (`e3afc369…cb36f63e`), also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.23/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
