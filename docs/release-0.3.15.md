# ResearchBunny 0.3.15 · 2026-10-25

## Changes

- **Emptying the archive keeps your collections.** A paper added to a collection is also saved to the archive. So **모두 선택 → 휴지통** in the archive used to send every collected paper to the trash too, and emptied the collections curated from it.
  - **휴지통** in **내 아카이브** (and its subtopics and 미분류) now leaves papers that are in one of the project's collections in the archive. The message says how many stayed: `69편을 휴지통으로 옮겼습니다. 컬렉션에 든 4편은 아카이브에 남겼습니다.` If every selected paper is in a collection, nothing moves and the message says to trash them from the collection.
  - Everywhere else, such as a collection view or 검토 대기함, **휴지통** trashes every selected paper as before. To discard a collected paper, open its collection and trash it there.
  - The check runs in the service (`trashWorks`), so it also covers papers selected with **모두 선택** on pages not opened yet. **되돌리기** restores the whole move in one step.
- **선택 반전.** A button next to **모두 선택 · N편** deselects the selected papers and selects the rest, over every page the current search and filters reach. Selections hidden by the search or filter, and the pinned groups above a run, stay as they are. The graph and year views have the same button next to **현재 필터 결과 N편 선택**. In a narrow list it wraps to the next line.
- Usage.md describes both, in the paragraph on selecting and removing archived papers.

Both changes were written on 2026-10-12 and 2026-10-14 in separate worktrees and left uncommitted. They are merged here onto 0.3.14.

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **223 passed, 0 failed** across 25 files, including a new test in `tests/integration/pending.test.ts`: from the archive, papers in this project's collections stay while a paper in another project's collection is trashed, duplicates are ignored, undo restores all of them, and trashing from a collection takes every paper.
- Browser harness (scratch library with 75 archived papers, papers 01–05 in a collection `핵심`; no shelf or network), driven in the built-in browser:
  - Two papers ticked, then **선택 반전**: 73 selected across both pages, the two ticked papers cleared.
  - **휴지통** with those 73 selected: 69 trashed and 4 collected papers kept. 내 아카이브 went from 75 to 6, 휴지통 from 2 to 71, and **되돌리기** brought back all 75.
  - In the `핵심` collection, **휴지통** on one paper trashed it (collection 5 → 4, archive 75 → 74); **되돌리기** restored it.
  - In the archive, **휴지통** on one collected paper moved nothing and showed the "모두 컬렉션에 있어" message.
- Packaged app: strict signature verification passed for the DMG's app and for the bundle inside it, and the packaged smoke test passed (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion with a restricted PATH).
- Not checked: both features in the installed app's own window.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.

## Installation

- Not installed. `/Applications/ResearchBunny.app` is still 0.3.13.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`, also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.15/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
