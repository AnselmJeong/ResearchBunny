# ResearchBunny 0.3.10 · 2026-10-22

## Changes

- **List search finds every word, in any order.** The find field of `내 아카이브` matched the whole query as one phrase. `lodge vinter` missed a paper by Lodge and Vinter, which the shelf search found.
  - The query is split into words. A paper stays when each word appears somewhere in its title, authors, abstract, citekey, note or tags. Order does not matter, and neither do case or accents: `Vinter, Lodge` finds the same paper, and `menard` finds `Ménard`.
  - This applies to `내 아카이브`, collections, topics, `미분류`, `검토 대기함`, `핵심 문헌`, `읽기 목록`, `제외 문헌` and `휴지통`, and to `결과 내 검색` in search results.
  - A line under the toolbar shows how many papers hold every word, with `검색 지우기`. A search with no match says so. Before, `내 아카이브` showed `첫 문헌부터 시작하세요.` in that case.
- **One search box, under each view's title.** The search box sat in the top bar and was small. `내 아카이브` and the other lists had only a small field in the list toolbar.
  - The box now sits under the view's title, in `문헌 탐색`, the shelf and every list. It is taller and wider, with an accent-coloured outline, and a focus ring while typing.
  - In `문헌 탐색` it searches OpenAlex, and the search options button sits beside it. In the shelf it runs the shelf's meaning-and-words search, as before. In the other lists it is labelled with the list's name and filters the list as you type.
  - The toolbar field remains only as `결과 내 검색` in search results, where the box under the title searches OpenAlex.
  - The top bar keeps the back and forward buttons, the project › view path, and the import, undo, export and inspector buttons. It is 52 px tall instead of 62 px.
  - In a narrow window the box drops the `⌘ K` hint and shortens its label.
- **⌘K** focuses the search box on screen in every list, and closes the reader first if one is open. Outside 문헌 탐색 and the shelf it used to open a new OpenAlex search.
- The `검색` buttons of the shelf and the lists have their own help text. They showed the OpenAlex one, which says the search empties `검토 대기함`.

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **208 passed, 0 failed** across 23 files. A new test checks that a list search matches words in any order, ignores case, commas and accents, requires every word, and treats a blank query as no search.
- The real renderer was built and run in Chromium against the real service on a scratch library: a 4-PDF shelf, 8 archived papers including ones by Lodge, Vinter and Ménard, a collection, fake Ollama and stubbed OpenAlex.
  - `내 아카이브`: `lodge vinter` and `Vinter, Lodge` (submitted with Enter) each listed only the Lodge and Vinter paper, with its count line. A query with no match showed the new empty message.
  - The collection: ⌘K focused its box, and `menard` listed the Ménard paper.
  - `문헌 탐색`: the empty search, a search run and the options popover, which opened over the list. `결과 내 검색` stayed in the results toolbar.
  - The shelf: ⌘K focused the `내 서고` box, and `lithium` listed the matching paper by relevance.
  - Light and dark themes, at 1440 and 1024 px wide with the inspector open.
- Packaged app: strict signature verification passed, and the packaged smoke test passed (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion with a restricted PATH). The package's renderer holds the new search text.
- Not yet checked: the native WebKit window.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261022-195634-search-box-0.3.10` (integrity ok, schema 3, **12,082 works**, **8,991 attachments**, **9,026 shelf files**, 6 projects, matching the live library). The replaced 0.3.9 bundle is kept there as `ResearchBunny-0.3.9-installed.app`.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.10**; all **242 files** match the package and strict signature verification passed.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.3.10/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
