# ResearchBunny 0.3.3 · 2026-10-12

## Changes

- `수신함 정리` no longer reopens on the last run's record. A proposal stays saved after its PDFs are moved, so reopening the dialog showed `152편을 옮겼습니다.`, `제안 다시 만들기` and `✓ 수신함에 정리할 PDF가 없습니다.` even with 90 new PDFs in the inbox. That empty-inbox line came from the old proposal, not from the inbox.
- The dialog now counts today's inbox (root and `_uncategorized`) each time it opens. With nothing left in the saved proposal, it shows `수신함에 PDF N편이 있습니다.` and `제안 만들기`; `✓ 수신함에 정리할 PDF가 없습니다.` appears only when the index has no inbox PDFs.
- When a proposal still has items and PDFs arrived after it was made, the dialog says how many are not in it and that `제안 다시 만들기` will include them. PDFs this proposal moved into `_uncategorized` are not counted as new.
- Moving the last items of a proposal clears it. Moving only some of them leaves `남은 제안 N편 · 옮길 논문 M편` instead of the move count. The move count and the ledger note stay in the dialog where the move happened.
- **Permanent deletion now deletes shelf PDFs.** Until 0.3.2, `선택 영구 삭제` and `휴지통 비우기` removed a shelf paper only from the project and never touched its PDF, so the paper came back in the shelf list. Now, when a trashed paper has PDFs on the shelf, they are deleted from disk at once:
  - in every folder, not just the inbox, including copies filed elsewhere;
  - without going through the macOS Trash;
  - for every project.

  The confirmation lists the PDFs it will delete. An offline shelf refuses the deletion. A PDF that cannot be deleted keeps its paper in the trash, and the message names it. The index drops the deleted files with their attachments, and works nothing else uses leave the library. With `_system` present, the deletion is logged as a `## delete … · ResearchBunny` block in `logs/intake-YYYY-MM-DD.md`, and `index.json` is rebuilt. `move_log.jsonl` is not written, because nothing moved.
- Trashing papers now clears them from every view's remembered selection, and restoring clears them from the trash view's. Before, a paper selected in another view stayed selected there, hidden from its list, so the status bar counted it and selection-bar actions still applied to it. Selections saved before 0.3.3 are settled when a project loads.
- Papers in the current project's trash no longer count in the sidebar's shelf, folder, `수신함` and `확인 필요` numbers; the lists already hid them. This made `수신함 1` appear above an empty inbox list. The shelf status line (`서고 N편 · 확인 필요 N편`) still counts every indexed file.

Library schema stays at 3. A proposal saved by 0.3.1 or 0.3.2 is read as before; when its items are used up, its old message is ignored.

## Validation

- Typecheck and lint passed. Integration suite: **194 passed, zero failed** across 21 files. This includes the selection test merged from the trash-selection fix.
- The inbox-sort test now also checks the following after the first move. Without the fix it fails, because the sorter has no inbox count.
  - The remaining proposal reads `남은 제안 1편 · 옮길 논문 1편` with 3 inbox PDFs and none new.
  - A PDF added afterwards counts as 1 new.
  - Moving the last item clears the proposal.
  - A 0.3.2-style saved state (`152편을 옮겼습니다.`, no items) reports every inbox PDF as new.
- New shelf test (fails without the change):
  - A trashed shelf paper leaves this project's sidebar counts but not another project's.
  - The preview lists the PDF in the inbox and both copies of a filed paper.
  - An offline shelf refuses the deletion.
  - A PDF that cannot be deleted keeps its paper in the trash.
  - The deleted files and their index rows are gone, and the rescan brings nothing back.
  - A paper another project uses keeps its record but loses the PDF.
  - The intake log and `index.json` record the deletion.
- The real renderer was run against a scratch library with a synthetic 5-PDF shelf. The two trashed papers left the sidebar counts. `휴지통 비우기` listed the 3 PDFs it would delete, and after confirming, the toast read `2편을 영구 삭제했습니다. 서고 PDF 3개를 지웠습니다.` Only the 2 untouched PDFs were left on disk.
- The 수신함 정리 dialog was rendered with stubbed states in the dark theme: a used-up 0.3.2 proposal with 90 inbox PDFs, an open proposal with 90 newer PDFs, and an empty inbox.
- The extracted stable app passed the restricted-PATH packaged runtime test and strict signature verification.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261012-210216-shelf-delete-0.3.3` (integrity ok, schema 3, **10,792 works**, **8,411 attachments**, **8,417 shelf files**, matching the live library). The replaced 0.3.2 bundle is kept there as `ResearchBunny-0.3.2-installed.app`.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.3**; all **441 files** match the package and strict signature verification passed. The installed app started its service on the existing library.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.3.3/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.

Not merged: the Codex worktree at `~/.codex/worktrees/electrobun-webkit` holds uncommitted changes from the September 26 Electrobun migration prototype, based on 0.1.2. `main` has had the finished migration since then, and merging that work would revert later changes, so it was left as is.
