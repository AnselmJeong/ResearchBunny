# ResearchBunny 0.3.22 · 2026-10-30

## Changes

- **Emptying a project's trash never touches the shelf.** `휴지통 비우기` and `선택 영구 삭제` now drop only what the project keeps about the papers: screening, notes, collection links, exploration results and the papers' chat threads. Their shelf PDFs stay on disk and in every shelf list, and a paper with a shelf PDF keeps its record. From 0.3.5 to 0.3.21 the dialog either hid those PDFs from the app (`앱에서만 지우기`, the default) or deleted them from disk (`서고 PDF도 삭제`). Both choices are gone. The dialog now names the PDFs only to say they stay, and the toast reads `N편을 이 프로젝트에서 영구 삭제했습니다. 서고 PDF M개는 서고에 그대로 있습니다.` Deleting no longer needs the shelf to be mounted. Deleting a project already followed this rule.
- **Importing a paper again brings it back.** A PDF or BibTeX import of a paper that this project has in the trash, among excluded papers, or cleared from the review queue now returns it to `검토 대기함`. Archived papers stay where they are, and attaching a PDF to a chosen paper leaves its screening alone. The import log notes `휴지통에서 되돌림` or `제외 문헌에서 되돌림`. Before, the same PDF matched the same paper, which stayed in the trash, so a re-import looked like it did nothing. Starting a project over is now: empty the trash, import again, search again.
- Shelf PDFs that an earlier version hid stay hidden until the same PDF is stored again (a download or an import), which shows them once more. The real library has 42 such files from 2026-10-14.
- **Downloads in the app's Chrome are not cut off while they are still arriving.** A paper's 60 seconds are now for finding the PDF. A download that keeps receiving bytes may run past that, up to 10 minutes per paper, and one that gets no bytes for 30 seconds counts as stalled. The page's own fetch of a same-site PDF (as on Sci-Hub mirrors) now gives up only after 15 seconds without data; before, it was aborted at 15 seconds even mid-download, and a slow PDF then started over from zero.
- **A dropped or stalled download gets one fresh start.** When Chrome gives up on a download (Chrome reports network errors as `canceled`) or it stalls, the same address is fetched once more from the beginning. A second failure moves on to the next paper with `서버가 30초 동안 PDF를 더 보내지 않아 다운로드를 멈췄습니다.` or the usual Chrome message.
- **No stray copies share the bandwidth.** A download that begins between papers, such as a late answer to an earlier navigation, is cancelled at once. Before, those copies and the restarts ran side by side: the app Chrome's own records showed one sci-hub.kr PDF started 2 to 4 times for a single paper.
- PDF links found on a page are opened with that page as the referrer, as a click would send it. While a PDF arrives, the item shows the size so far, e.g. `앱 전용 Chrome에서 PDF 내려받는 중 · 288KB / 679KB`.

Library schema stays at 3.

## Validation

- Typecheck and lint passed. Integration suite on macOS, after a full build: **303 passed, 0 failed** across 35 files.
- `shelf.test.ts`, on scratch shelves:
  - permanent deletion leaves every file, record and status unchanged, also with the share unmounted;
  - the papers are listed again in this project's shelf and stay in another project's;
  - importing the same PDFs again brings a deleted paper back as new and a trashed one out of the trash, without storing a second copy, and an archived paper stays archived;
  - a hidden row left by an older version returns when the same bytes are stored again.
- `trash.test.ts`: a BibTeX import returns trashed, excluded and cleared papers to the review queue and leaves an archived one. The test fails without the change.
- `chrome-download.test.ts`:
  - a download that keeps trickling runs past the deadline and completes, with progress showing the bytes so far;
  - a download Chrome gives up on starts once more and completes, with the page as referrer;
  - two stalls in a row end with `CHROME_STALLED`.
- `chrome-host.test.ts`: downloads begun before or after a paper are cancelled and one during it is kept, and `Page.navigate` carries the referrer.
- Throwaway Chrome 156 (temporary profile, minimized window, the app's flags):
  - a 30 MB download ran at 0.54 and 0.71 MB/s, against 1.18 to 1.31 MB/s with curl on the same address;
  - launching with `-NSAppSleepDisabled YES` gave 0.48 MB/s, so App Nap is not what slows these downloads;
  - against a local server that drops the connection after 100 KB, Chrome reported `inProgress` with growing bytes, then `canceled`.
- Packaged app: the DMG's checksum is valid and strict signature verification passed for the bundle inside the `.tar.zst` (0.3.22). The packaged smoke test passed on the extracted bundle with a restricted PATH (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion). The renderer no longer contains `서고 PDF도 삭제`, and the packaged service contains `CHROME_STALLED`.
- Not checked: a real Sci-Hub or publisher download in the new build, the real shelf, and the installed app's own window.

## Known issues

- Single connections to sci-hub.kr are uneven: between 0 and about 380 KB/s in the app's records. The app cannot make the server send faster; it now stops cutting such downloads off and stops running several copies at once.
- Pressing `Open` on Chrome's embedded-PDF placeholder during a run adds a second copy of the same file. The app fetches the embedded PDF itself, so there is no need to press it.
- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261030-211645-trash-chrome-0.3.22` (integrity ok, schema 3, **12,475 works**, **9,292 attachments**, **9,329 shelf files**, 7 projects, matching the live library). The replaced 0.3.21 bundle is kept there as `ResearchBunny-0.3.21-installed.app` (signature verified, identical to what was installed). `passages.sqlite` was not copied: 0.3.22 does not change it, and the 0.3.18 backup holds a clone.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.22** (bundle hash `26lbqwerz4a0d`); all **242 files** match the package and strict signature verification passed. The app was not running and was not launched.
- The 42 shelf PDFs hidden on 2026-10-14 are still hidden; nothing in the library was changed by the install.

Artifacts, built from `9426f02`: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` (SHA-256 `7bb774c6…e117cf84`) and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst` (`73ed08de…6c151750`), also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.22/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
