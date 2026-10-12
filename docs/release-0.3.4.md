# ResearchBunny 0.3.4 · 2026-10-12

## Changes

- **`수신함` is now the shelf root only.** Until 0.3.3 the inbox was the root plus `_uncategorized`. A paper that `수신함 정리` moved to `_uncategorized` therefore stayed in the inbox count, came back in every proposal and went to the AI again, usually only to be proposed for `_uncategorized` once more.
  - `_uncategorized` now has its own sidebar entry, `미분류`, under the inbox. It lists the folder and its subfolders. The folder no longer appears in the tree.
  - Proposals cover root PDFs only. The dialog has an option, `미분류 N편도 다시 판정`, to include `_uncategorized`. It is already on when the dialog is opened from the 미분류 list, which now also has the `수신함 정리` button.
  - Without the option, `_uncategorized` PDFs count as existing copies, so a root PDF identical to one of them is proposed for `_duplicated`.
- **Reopening `수신함 정리` starts from today's inbox.** In 0.3.3 a saved proposal with any item left still came back. The user's case: a 0.3.2 proposal whose only leftover was a paper already in `_uncategorized`. Reopening showed `89편을 옮겼습니다.` and that one paper, plus a warning that 119 newer PDFs were missing from the proposal. Now a saved proposal comes back only when both of these hold:
  - it saw every PDF now in the inbox;
  - it still has a move to make.

  Otherwise the dialog shows `수신함에 PDF N편이 있습니다.` and a primary `제안 만들기`, without the old message or items. The decision is made once, when the dialog opens. A proposal made or used in that dialog stays on screen, and PDFs that arrive meanwhile are still reported.
- A paper already in the folder its proposal names (a 미분류 paper the AI cannot place) reads `그대로 두기` instead of `미분류 (_uncategorized)`. Moving the last real move of a proposal now finishes it even when such papers remain, so they no longer keep `남은 제안 N편 · 옮길 논문 0편` alive.
- The `옮길 논문 선택` button appears only while there is a proposal to move from.

Library schema stays at 3. A proposal saved before 0.3.3 kept no list of the PDFs it saw, so it is never shown again; the next `제안 만들기` replaces it. Nothing on disk changes: `_uncategorized` keeps its files, and the ledger format is the same.

## Validation

- Typecheck and lint passed. Integration suite: **194 passed, zero failed** across 21 files.
- The inbox-sort test was updated for the root-only inbox and now also checks:
  - `_uncategorized` is left out of the default proposal and the AI payload;
  - a root copy of a `_uncategorized` PDF is proposed for `_duplicated`;
  - after a move, the sidebar counts 1 in the inbox and 2 in `미분류`, the tree hides `_uncategorized`, and the inbox list holds only root papers;
  - `current` is true for a covering proposal with a move left and false after a new PDF arrives or for a pre-0.3.3 proposal;
  - with `uncategorized: true`, 미분류 papers are judged, and moving the only real move finishes the proposal.
- The real renderer was run against a synthetic shelf with local embeddings and a keyword stand-in for the AI, in the dark theme. Starting from a 0.3.2-style saved state (`89편을 옮겼습니다.` and one 미분류 paper) with 4 new PDFs:
  - the dialog opened on `수신함에 PDF 4편이 있습니다.` and `제안 만들기`;
  - the proposal covered the 4 new PDFs;
  - reopening resumed it;
  - with 미분류 included, the two 미분류 papers read `그대로 두기`, and moving the 4 picks ended the proposal;
  - opened from the 미분류 list, the option was already on.
