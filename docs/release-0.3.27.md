# ResearchBunny 0.3.27 · 2026-10-31

## Changes

- **A collection can keep only what its filters keep.** Before, there was no way to drop papers from a collection in bulk. `선택 반전` flipped only the papers the filters showed, so its result sat off screen while the list stayed the same. The collection's `휴지통` button took papers out of the whole project.
  - The filter banner (`필터로 제외된 문헌 N편`) has `제외된 문헌 보기`. It lists the papers the filters leave out, each with its reason. `필터 결과 보기` or `필터 초기화` returns to the filter's result. Each view remembers which side it shows; a new exploration never starts from it.
  - In a collection the banner also has `컬렉션에서 빼기…`. The dialog shows how many papers leave, how many stay and how many each reason leaves out, and notes when a search narrows the count. After the removal the view returns to the filter's result.
  - When selected papers are hidden by the filters, the banner says `선택한 문헌 중 N편이 여기에 가려 있습니다`. `선택 반전`'s help now says it never changes the selection of hidden papers.
- **`컬렉션에서 빼기` for hand-picked papers.** In a collection the selection bar has `컬렉션에서 빼기` in place of `휴지통`. The trash stays in `일괄 편집` as `프로젝트 휴지통으로`, with a line saying how the two differ. Elsewhere the trash button's help says it takes papers out of every list in the project and leaves shelf PDFs alone.
- **Undo puts papers back in a collection.** A removal is one entry for the top `되돌리기`, whether it came from the banner, the selection bar or a collection chip in the inspector. Permanent deletion still drops deleted papers from every undo entry, so undo never brings one back.

Library schema stays at 3. Nothing in the library changes on install. Undo in an older app consumes a collection removal without restoring it.

## Validation

- `collections.test.ts` (new): removing papers leaves the archive and other collections alone, ignores papers not in the collection and repeated ids, and one undo restores them all. A removal that removes nothing records nothing. Another project's collection is refused. A filtered-out list returns every hidden id across pages and the count per reason, and leaves out trashed papers. Keeping only the filter's result leaves the archive whole. A permanently deleted paper does not return through a collection undo.
- QA in the browser pane against a scratch library (30 synthetic papers in one collection, 5 of them also in another; not the real library). Selecting all 30 and filtering on `plasticity` showed `선택한 문헌 중 20편이 여기에 가려 있습니다`. After `선택 반전`, `제외된 문헌 보기` listed those 20 selected, each with `포함어 없음: plasticity`. `컬렉션에서 빼기…` left the collection at 10, the archive at 30 and the other collection at 5, then returned to the filter's result; `되돌리기` restored 30. With a 2015 start year as well, the dialog showed both reasons (20 and 14) and 24 out, 6 left. The selection bar's `컬렉션에서 빼기` with undo, the `일괄 편집` wording, and light and dark themes were checked. No console errors.
- Typecheck and lint passed. Integration suite on macOS after a full build: **316 passed, 0 failed** across 36 files.

## Known issues

- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
