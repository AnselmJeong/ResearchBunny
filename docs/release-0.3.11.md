# ResearchBunny 0.3.11 · 2026-10-22

## Changes

- **The reader shows pages again.** Since 0.3.9, every PDF opened in the app showed blank white pages. The page count, page size and zoom were right, so the PDF itself had opened.
  - Cause: the app's content security policy (`index.html`) allowed images only from the app itself and from `data:` URLs. EmbedPDF draws each page and each zoom tile as a PNG and shows it as a `blob:` image, so WebKit blocked every one of them and only the white page background was left. The 0.3.9 checks ran the reader in a test page that had no such policy, so they did not catch it.
  - `img-src` now allows `blob:` as well. Only the app's own scripts can make `blob:` URLs, so the reader still loads nothing from outside the app.
- A new test checks that the policy in `index.html` and in the built renderer allows `blob:` images, `blob:` workers and WebAssembly, which the reader needs.

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **209 passed, 0 failed** across 23 files. The new test fails against the 0.3.10 policy (`img-src` held only `'self'` and `data:`).
- WebKit check. The reader harness was rebuilt from this source with the packaged app's exact policy and loaded into a `WKWebView` through a `views://` scheme handler, which is how Electrobun serves the app.
  - With the 0.3.10 policy, every page image failed to load (0 × 0 px) and the pages were blank. This matches the report, using the reported shelf PDF: a two-page Nature research briefing whose fonts are all embedded and which passes `qpdf --check`.
  - With the new policy, that PDF, `korean-paper.pdf` and the 320-page `long-book.pdf` drew their pages: 1191 × 1582 px page images at 100 %, and tiles of 1191 × 1536 px.
- Packaged app: strict signature verification passed, and the packaged smoke test passed (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion with a restricted PATH). The package's `index.html` has `img-src 'self' data: blob:`.
- Not yet checked: the reader in the installed app's own window.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261022-210540-reader-csp-0.3.11` (integrity ok, schema 3, **12,090 works**, **9,013 attachments**, **9,048 shelf files**, 6 projects, matching the live library). The replaced 0.3.10 bundle is kept there as `ResearchBunny-0.3.10-installed.app`.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.11**; all **242 files** match the package and strict signature verification passed. The app was not running.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs and WebKit snapshots are under `.qa/release-0.3.11/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
