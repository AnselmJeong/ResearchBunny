# ResearchBunny 0.3.23 · 2026-10-30

## Changes

- **`수신함` counts its PDFs, as `수신함 정리` does.** The sidebar number used to count papers in the root folder, minus papers in the open project's trash, so it disagreed with the number of files `수신함 정리` offered to sort (64 against 72 on the real shelf). It now counts the root folder's PDFs that are on disk and not hidden, the same rule `수신함 정리` uses, for every project. Of the 8 the real shelf was missing, 1 was a second file of the same paper (Gluck et al. 2025) and 7 were papers in one project's trash whose PDFs still sat in the inbox.
- **The inbox lists papers that are in this project's trash.** They still have a PDF waiting to be sorted, so the inbox shows them, marked `이 프로젝트 휴지통에 있음`, and its list matches its count again. Other shelf folders still leave this project's trashed papers out of their lists and counts.
- The inbox heading still counts papers. When the inbox holds more PDFs than papers (a second copy of a paper, or a PDF still being indexed), it adds `PDF N개` beside the count. It shows only when no search or filter narrows the list.

Library schema stays at 3.

## Validation

- Typecheck and lint passed.
- `shelf.test.ts`: on a scratch shelf, the sidebar count and the `수신함 정리` count are equal, and a paper trashed in this project keeps both and stays listed with its trash state. A second copy of a paper adds one PDF to both counts and no paper to the list. The deletion test now expects the inbox to keep counting a trashed paper's PDF.
- Read-only check of the real library: the root folder holds 72 PDFs on disk and 74 index rows, 2 of them missing; 71 papers; 7 of them in the trash of `Self-Reparing Mechanism and NIBS`.
- Not checked: the real shelf in the new build and the installed app's own window.

## Known issues

- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.
