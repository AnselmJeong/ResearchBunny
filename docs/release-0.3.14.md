# ResearchBunny 0.3.14 · 2026-10-25

## Changes

- **A last route for missing PDFs: Sci-Hub mirrors.** **PDF 원문 찾기** can now try Sci-Hub mirrors for papers that every other route missed. The shelf, download-folder recovery, Chrome and open-access routes (Unpaywall, publisher addresses) still come first.
  - The mirror page is `<mirror>/https://doi.org/<DOI>`, for example `https://sci-hub.kr/https://doi.org/10.1017/S1092852900013754`. A paper without a DOI is tried only when Crossref finds a DOI that clearly matches it.
  - The PDF from the mirror page (`citation_pdf_url`, a PDF `object` or a download link) goes through the same checks as any other candidate: PDF parsing, no supplements or errata, and DOI and title conflict checks. The attachment keeps the mirror's PDF address as its source, and the run says `Sci-Hub(미러)에서 PDF 확보`.
  - **자동 원문 찾기 설정 → 다른 경로 실패 시 Sci-Hub 미러 사용** turns it on and off. Mirrors go one per line and are tried from the top; the default is `https://sci-hub.kr`. Both are remembered for the next run, and retrying a run keeps that run's own choice.
  - The app never answers a robot check (ALTCHA `로봇 확인`, DDoS-Guard). Over HTTP it moves on to the next mirror. With **로그인된 Chrome 사용** on, the mirror page opens in the Chrome work tab so you can finish the check yourself within the usual 30-second wait. Chrome is not opened when the mirror has no paper or its PDF fails the checks.
  - Limits: the mirror step takes at most 120 seconds per paper, and one PDF request at most 60 seconds.
- Chrome detection now treats a Sci-Hub robot check as a human check, but not the ALTCHA report form on an article page. It also picks up PDF `object`, `embed` and `iframe` links.
- README and `docs/fulltext-download.md` describe the new route.

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **222 passed, 0 failed** across 25 files, including 6 new tests in `tests/integration/sci-hub.test.ts`: mirror addresses, moving to the next mirror after a robot check, a missing article as a final answer, Crossref first when there is no DOI, Sci-Hub only after the other routes fail, remembered settings, and opening the mirror page in Chrome.
- Packaged app: strict signature verification passed for the DMG's app and for the bundle inside it, and the packaged smoke test passed (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion with a restricted PATH).
- Not checked: the route against live Sci-Hub mirrors, and the installed app's own window.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.

## Installation

- Not installed. `/Applications/ResearchBunny.app` is still 0.3.13.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.3.14/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
