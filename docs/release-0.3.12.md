# ResearchBunny 0.3.12 · 2026-10-22

## Changes

- **Reading state in one click.** Before, marking a paper as read meant opening the inspector's 노트 tab and picking from a dropdown.
  - The inspector now shows **읽을 예정 / 읽는 중 / 읽음** as checkbox-style buttons right under the save button, whichever tab is open. Clicking one marks it. Clicking the marked one returns the paper to 미열람.
  - The dropdown in the 노트 tab is removed, so the state is set in one place.
  - The bulk edit dialog (⋯) sets the reading state of the selected papers with four buttons (**미열람 / 읽을 예정 / 읽는 중 / 읽음**) instead of a dropdown.
- **Right-click selects a row.** Right-clicking anywhere on a list row selects it, and right-clicking it again clears it, the same as its checkbox. Shift + right-click selects every row between the last one toggled and the clicked row. The pinned 내 서고에서 찾음 rows in 문헌 탐색 work the same way. List rows no longer open a context menu.
- **Selected rows stand out.** Hover and selection used the same background, so a selected row looked like the row under the pointer. Selected rows now have their own green background, in the light and dark themes. Hover is a faint neutral tint.
- Usage.md describes the new selection and reading buttons.

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **209 passed, 0 failed** across 23 files.
- Browser harness (scratch library, 8-paper archive, OpenAlex stubbed), driven with real mouse clicks:
  - Right-clicking rows selected and cleared them. The count in the selection bar and the row checkboxes followed. The same worked on 문헌 탐색 search results.
  - The inspector's 읽음 button marked the paper, and the list showed 읽음. Clicking it again returned the paper to 미열람.
  - Bulk edit set two right-click-selected papers to 읽는 중.
  - Selected rows were clearly green in the light and dark themes.
- Not checked in the browser: right-clicking the pinned 내 서고에서 찾음 rows, because the harness search returned no shelf matches. They use the same handler as the list rows.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
