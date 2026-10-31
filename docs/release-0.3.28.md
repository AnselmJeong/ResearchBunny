# ResearchBunny 0.3.28 · 2026-11-01

## Changes

- **A filter shows what meets it.** The list keeps only the papers that meet the filter's conditions. A line above it names the conditions and counts the papers, for example `필터 포함어 plasticity → 조건에 맞는 문헌 10편 / 30편`. Rows carry no filter tags. The filter button shows how many conditions are set. `조건 지우기` clears them.
- **조건 반전 (NOT).** The switch is on the status line and at the bottom of the filter panel. It puts NOT over every condition, so the list shows the papers that fail at least one: `NOT (포함어 plasticity) → 조건에 맞지 않는 문헌 20편 / 30편`. The reading tab and the 숨김 options are never flipped. With no condition set there is nothing to flip, so the switch is disabled, and clearing the last condition turns it off. To trim a collection, set the filter, flip it, select the papers and press `컬렉션에서 빼기`.
- **Changing a filter lets go of hidden picks.** When a filter or its NOT changes, papers the new list no longer shows are deselected, so `컬렉션에서 빼기` or the trash never reaches papers out of sight. `선택 반전` flips the selection within the list on screen, and its help points to NOT for flipping the conditions.
- **A collection lists every paper put in it.** Papers marked `제외` with 일괄 편집 used to be hidden by the default `제외 문헌 숨김`. The list called them `필터로 제외된 문헌` and tagged them `사용자 제외`, and neither a filter reset nor a restart cleared it. They now show like the rest, and the collection's filter panel no longer offers that option. 일괄 편집 notes that `제외` changes only the review decision and leaves the paper in the collection. To put such papers back in the archive, select them in the collection and press `저장`.
- **The 0.3.27 banner is gone.** `제외된 문헌 보기`, `필터 결과 보기`, the banner's `컬렉션에서 빼기…` and its dialog were removed. Saved views drop the old `filteredOut` flag when they load, so a view left showing the filtered-out papers opens as a plain list. The selection bar's `컬렉션에서 빼기` and undo work as in 0.3.27.

Library schema stays at 3. Nothing in the library changes on install. Papers already marked `제외` keep that state.

## Validation

- `collections.test.ts`:
  - With no conditions, a collection lists every member, including papers marked `제외`, and leaves out trashed ones.
  - Conditions keep only matching papers across pages. NOT lists the papers that fail any condition, with no hidden reasons, and with no condition set NOT is the plain list.
  - NOT leaves the reading tab alone. Outside collections, `제외 문헌 숨김` still hides a paper marked `제외`, even under NOT.
  - Removing the flipped papers leaves the collection with the filter's result and the archive whole.
  - Collection removal and undo tests are unchanged and pass.
- QA in the browser pane against a scratch library (not the real one): a 30-paper synthetic collection, 15 of its papers marked `제외`.
  - A view saved by 0.3.27 in filtered-out mode opened as a plain list.
  - `2015년부터 · 포함어 plasticity` showed `6편 / 30편`, and the count included papers marked `제외`. NOT listed the other 24 without tags.
  - Turning NOT off with all 24 selected cleared the selection.
  - Taking the 24 out with `컬렉션에서 빼기` emptied the NOT list. After `조건 지우기` the collection held 6, and `되돌리기` restored all 30.
  - Light and dark themes were checked. No console errors.
- Typecheck and lint passed. Integration suite on macOS after a full build: **316 passed, 0 failed** across 36 files.
- Not checked: the installed app against the real library.

## Known issues

- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.
