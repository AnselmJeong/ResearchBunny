# ResearchBunny 0.3.9 · 2026-10-18

## Changes

- **The full-text reader uses EmbedPDF.** It drew one pdf.js page at a time at the fit-width scale. Scrolling stopped at the end of each page, and a whole page could not be shown at once. The reader now uses EmbedPDF 2.15.1, which runs PDFium in a worker. PDFie uses the same engine.
  - **Scrolling.** Pages follow one another, so scrolling carries on into the next page. The page box in the toolbar follows the scroll.
  - **Zoom.** `폭 맞춤` fits the page width to the window. `페이지 맞춤` fits a whole page. `−` and `+` (⌘− and ⌘+) step the zoom, and the percentage button returns to 100% (⌘0). A trackpad pinch also zooms. Switching zoom keeps the top of the view in place.
  - **Paging.** ← and → and PageUp and PageDown turn pages. In `페이지 맞춤`, ↑ and ↓ turn pages too, and the page is centred with equal space above and below. Home and End go to the first and last page. In the other zoom modes ↑ and ↓ scroll as before. When zoomed in, turning a page keeps the horizontal position. Keys typed into an input, the sidebars or a dialog are left alone.
  - **Text.** Text can still be selected by dragging, and ⌘C copies it.
  - **Remembered settings.** The page is still kept for each attachment and survives `탐색 / 원문` switching. The zoom is now one setting for every PDF: the last choice applies to the next PDF opened. Until 0.3.8 the zoom was kept for each attachment.
- **No network use.** `pdfium.wasm` (4.6 MB) is bundled with the app. EmbedPDF's font fallback, which downloads CJK and other fonts from a CDN, is turned off, so the reader makes no network requests. A PDF that does not embed its fonts may show blank glyphs. Papers normally embed them.
- pdf.js still extracts text for AI chat and imports, in its worker. The renderer no longer ships pdf.js's fonts, CMaps and wasm (about 4 MB).

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before. A zoom saved by 0.3.8 or earlier is not carried over; the reader starts at `폭 맞춤`.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **207 passed, 0 failed** across 23 files. `bun run build` produced the development app with `pdfium.wasm` in its renderer assets.
- The real reader component was built with Vite and run in Chromium (the built-in browser pane), with `window.bunny` stubbed to serve PDFie's generated fixtures through the same 512 KiB chunk reads.
  - 320-page `long-book.pdf`: continuous scrolling rendered only the pages near the view, and the page box followed it. `페이지 맞춤` fitted a page at 76% and centred it. →, ↓, ←, ↑, PageDown, Home and End moved to the expected pages. In a percentage zoom, ↓ scrolled 42 px instead of turning the page. At 327%, → turned the page and kept the horizontal scroll at 300 px.
  - Reopening restored the saved page and zoom, including a saved percentage. Hiding and showing the reader kept page 3 and its scroll position, and focus returned to the pages.
  - `two-column-paper.pdf`: dragging over the left column selected only that column. ⌘C put its four lines, in order, on the clipboard.
  - `korean-paper.pdf` rendered its Korean text.
  - Arrow keys and End typed into an input outside the reader did not move the reader.
- Packaged app: strict signature verification passed, and the packaged smoke test passed (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion with a restricted PATH). The package has `pdfium.wasm` in its renderer assets.
- Not yet checked: the reader in the native WebKit window.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261018-181740-embedpdf-reader-0.3.9` (integrity ok, schema 3, **11,870 works**, **8,764 attachments**, **8,800 shelf files**, 6 projects, matching the live library). The replaced 0.3.8 bundle is kept there as `ResearchBunny-0.3.8-installed.app`.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.9**; all **242 files** match the package and strict signature verification passed. 0.3.8 had 441 files; 200 of them were pdf.js's renderer fonts, CMaps and wasm, which this release drops.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.3.9/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
