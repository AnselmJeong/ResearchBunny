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
- The extracted stable app passed the restricted-PATH packaged runtime test and strict signature verification.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261012-200133-trash-button-0.3.2` (integrity ok, schema 3, **10,094 works**, **8,332 attachments**, **8,338 shelf files**, matching the live library). The replaced 0.3.1 bundle is kept there as `ResearchBunny-0.3.1-installed.app`. The live database is `ResearchBunny/library/library.sqlite`, not the data folder root.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.2**; all **441 files** match the package and strict signature verification passed. The installed app opened the existing library.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.3.2/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.

Known behavior, unchanged: restoring a shelf paper that was never saved to the project puts it in `검토 대기함`, because its project membership starts as pending.
