# ResearchBunny 0.3.4 · 2026-10-12

This release merges five worktrees: the inbox and `_uncategorized` split, project management, taking papers out of the archive, row clicks that no longer load PDFs, and shelf names for exported PDFs.

## Changes

### Inbox and `_uncategorized`

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

### Projects

- **The project list is in order of last use.** Opening a project moves it to the top, and the app now starts in the project opened last; until 0.3.3 it always started in the oldest one. Opening times were not recorded before, so at first the list runs newest-created first and settles as projects are opened.
- **Rename and delete projects** in the new `프로젝트` section of Settings, reached from `프로젝트 관리` at the bottom of the switcher.
  - Renaming keeps the research question (Enter saves, Escape cancels).
  - The delete confirmation counts what goes with the project: paper states, notes and tags, collections, exploration, import and full-text records, AI chats, seeds, topics, saved views and undo history. It cannot be undone.
  - **No PDF file is deleted, shelf PDFs included.** Papers another project, the shelf or a remaining history still uses keep their records; only papers nothing uses leave the library, by the same rule as permanent trash deletion.
  - Deletion is refused while an exploration, import, classification or AI chat runs, and for the last project. Deleting the open project first switches to the next most recently opened one, and switches back if the deletion is refused.

### Archive and lists

- **`아카이브에서 빼기`** replaces the always-disabled `저장` in the selection bar of 내 아카이브, its topics and 미분류. It sends the saved papers among the selection back to 검토 대기함; excluded and trashed papers stay put. Records, PDFs, notes, tags and collections are kept, and undo restores the archive.
- **`모두 선택 · N편`** appears beside `이 페이지 전체 선택` when results span pages and selects every paper the current search and filters match. Selection checks were made faster for thousands of papers.
- **Clicking a row opens only its record.** Every list now behaves like the shelf list: the PDF, possibly on the NAS, is not read until asked for. Papers with a PDF have a small `원문 보기` button under the save icon, also in the shelf matches above search results; the inspector's `원문 보기` and the top toggle still work.

### PDF export

- **Exported PDFs keep their shelf names.** Shelf PDFs were exported with a second year (`2024 - 2024 - …`) and every name was cut at 170 bytes mid-word. Names now get the year prefix once and are cut at a word with ` ...` to fit 240 bytes, by the same function the shelf uses. Project and topic folder names keep their 170-byte limit.

Library schema stays at 3. Projects' opening times are kept in a new `project_opens` table rather than a new `projects` column, so 0.3.3 still reads and creates projects in this library. A proposal saved before 0.3.3 kept no list of the PDFs it saw, so it is never shown again; the next `제안 만들기` replaces it. Nothing on disk changes: `_uncategorized` keeps its files, and the ledger format is the same.

## Validation

- Typecheck and lint passed on the merged tree. Integration suite: **200 passed, zero failed** across 22 files.
- The inbox-sort test was updated for the root-only inbox and now also checks:
  - `_uncategorized` is left out of the default proposal and the AI payload;
  - a root copy of a `_uncategorized` PDF is proposed for `_duplicated`;
  - after a move, the sidebar counts 1 in the inbox and 2 in `미분류`, the tree hides `_uncategorized`, and the inbox list holds only root papers;
  - `current` is true for a covering proposal with a move left and false after a new PDF arrives or for a pre-0.3.3 proposal;
  - with `uncategorized: true`, 미분류 papers are judged, and moving the only real move finishes the proposal.
- New project tests (`projects.test.ts`):
  - order by last opening, kept across a restart, and no write when the open project is polled;
  - renaming keeps the question;
  - deletion removes the project's rows, chat heads, preferences and merge history; keeps shared, shelf and other-seeded papers and the PDF file; and refuses while a job runs, for the last project and for a missing one.
- Archive tests cover taking papers out (only saved ones move, undo restores them) and selecting every page. The export test covers a shelf name kept whole and a long plain name cut at a word within 240 bytes.
- The real renderer was run against scratch libraries:
  - Inbox: a synthetic shelf with local embeddings and a keyword stand-in for the AI, in the dark theme. Starting from a 0.3.2-style saved state (`89편을 옮겼습니다.` and one 미분류 paper) with 4 new PDFs, the dialog opened on `수신함에 PDF 4편이 있습니다.` and `제안 만들기`, and the proposal covered the 4 new PDFs. Reopening resumed it. With 미분류 included, the two 미분류 papers read `그대로 두기`, and moving the 4 picks ended the proposal. Opened from the 미분류 list, the option was already on.
  - Projects:
    - list order after switching, and the app reopening the last project;
    - renaming, with the sidebar and breadcrumb updating, and Escape cancelling;
    - deleting the open project, and a refused deletion returning to it;
    - delete disabled for a single project, and long names wrapping;
    - light and dark themes.
  - Archive: 75 saved papers taken out with 모두 선택 and restored by undo.
  - Lists: a row click read no PDF; the row button and the inspector's `원문 보기` did.
  - After merging, the combined renderer showed `아카이브에서 빼기`, inspector-only row clicks and `프로젝트 관리` without script or service errors.

Not merged:
- Two worktrees held only untracked plan documents identical to `docs/archive_plan.md` and `docs/linked-discoveries-plan.md` on `main`.
- The Codex worktree at `~/.codex/worktrees/electrobun-webkit` still holds the September 26 Electrobun migration prototype, based on 0.1.2. `main` has had the finished migration since then, and applying that work would undo 37 later commits, so it was left as is.
