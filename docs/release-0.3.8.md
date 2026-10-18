# ResearchBunny 0.3.8 · 2026-10-18

## Changes

- **Each search box says what it searches.** The search box in `문헌 탐색` searched the shelf and OpenAlex together, and `서고만 검색` was hidden in its options menu. The shelf could only be searched from a small field in the list toolbar. Nothing on screen showed which search was which.
  - **`문헌 탐색`.** The box is labelled `OpenAlex` and searches only OpenAlex. Search runs no longer add a shelf step or the pinned `내 서고에서 찾음` group. Results the shelf already holds still carry their `서고 · 폴더` badge, and the `서고` filter still shows or hides them. The `서고만 검색` button is gone. Search runs made with 0.3.7 or earlier keep their pinned group.
  - **The shelf.** Choosing the shelf or a folder puts the same search box in the same place. It is labelled `내 서고` or the folder's name, and it runs the shelf's meaning-and-words search in that scope, as the toolbar field did. That field is gone.
  - **⌘K** focuses the search box on screen. Outside 문헌 탐색 and the shelf, it opens a new OpenAlex search.
- **`문헌 탐색` starts a new search.** It used to reopen the latest run, which could be a PDF import from weeks before. It now opens an empty search with a `최근 탐색` list below it.
  - Each row shows the run's kind, its query or starting papers, the paper count, the status if the run did not complete, and the date.
  - A row reopens that run with its selection and filters.
  - The list shows the 12 latest runs, and `더 보기` shows the rest.

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before.

## Validation

- Typecheck and lint passed. Integration suite: **204 passed, 3 failed** across 23 files. The 3 are the single-instance lock, Keychain and service IPC tests, which need the macOS native helpers. They fail the same way without this change on Linux, where the run took place.
- The search-run test now checks that a search has only its OpenAlex step and no pinned shelf group. The paper the shelf holds appears among the results with its badge and folder, and the `서고` filter shows or hides exactly that paper. Shelf-only runs still make no API calls.
- The real renderer was built and run in Chromium against the real service on a scratch library: 5 shelf PDFs in folders, stubbed OpenAlex, fake Ollama.
  - `문헌 탐색` opened an empty search with both earlier runs listed. Opening one showed the `OpenAlex` label and the shelf badge on the paper the shelf holds.
  - Choosing the shelf showed the `내 서고` box. A search listed the matching paper by relevance.
  - Choosing a folder showed its name in the label, cut short when long. ⌘K focused that box.
- Not yet checked: the native WebKit window and the packaged app.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.
