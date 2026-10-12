# ResearchBunny 0.3.2 · 2026-10-12

## Changes

- Add a `휴지통` button to the selection bar next to `내보내기`. It moves the checked papers to the trash, clears the selection and can be undone with the top `되돌리기`. The trash view keeps `선택 영구 삭제` in its place. The bulk-edit dialog's `휴지통` uses the same action.
- Trashed papers no longer stay in shelf folders, shelf search results, the shelf graph or exploration runs. These lists show works regardless of project state, so a paper trashed from a shelf folder used to remain on screen. Trash is project-scoped: other projects still list the paper on the shelf. Sidebar folder counts still count the PDFs on disk.
- The permanent-deletion dialog says that shelf papers return to the shelf list, because the shelf PDF is never deleted.

Library schema stays at 3; 0.3.0 and 0.3.1 can still open libraries used by 0.3.2.

## Validation

- Typecheck and lint passed. Integration suite: **192 passed, zero failed** across 21 files.
- New test: a trashed shelf paper leaves the shelf folder, the whole-shelf list and a run in its project, stays listed for another project, appears in the trash, and comes back after a restore. It fails without the fix.
- The real renderer was checked against a synthetic 12-PDF shelf: the button is disabled until a paper is checked, the trashed paper leaves the folder list at once and appears in the trash, and restoring returns it to the folder.

Known behavior, unchanged: restoring a shelf paper that was never saved to the project puts it in `검토 대기함`, because its project membership starts as pending.
