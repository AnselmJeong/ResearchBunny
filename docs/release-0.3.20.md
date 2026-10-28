# ResearchBunny 0.3.20 · 2026-10-28

## Changes

- **arXiv ids work wherever a DOI does.** The lookup field in 발견 근거 (now `DOI·arXiv·PMID로 직접 확인`), the 문헌 탐색 search box and the shelf search box accept `arXiv:2610.27099v1`, a bare `2610.27099`, an arxiv.org link or an old-style `hep-th/9901001`. The app drops the version and asks for arXiv's DataCite DOI (`10.48550/arxiv.2610.27099`); arXiv registered one for every paper in 2022, old ones included. Until now `arXiv:…` failed with "DOI, PMID 또는 OpenAlex ID가 필요합니다".
- **arXiv PDFs are matched by their stamp.** Shelf indexing reads the `arXiv:…` stamp and arxiv.org links on pages 1–2 as DOI candidates, ahead of printed DOIs. This finds preprints whose title changed between versions (a filename title at 0.78 similarity used to end in `확인 필요`). When OpenAlex has merged a preprint into its journal record, that record carries the journal DOI, so the batch lookup also looks for the requested DOI in each record's `locations`.
- **A filename author may be any author.** A title search match (similarity 0.9 or more) needed the filename's author to be OpenAlex's first author. Filenames often name a co-author, and preprints and journal versions order authors differently, so exact titles stayed in `확인 필요` (Ramstead is second after Friston, Olson-Urtecho 32nd of 49). Any author now counts, and leading surname particles are skipped (`de Koning` matches `Marieke Koning`; a lone `Le` stays a surname).
- **Lookups fall back to doi.org.** When OpenAlex does not know a DOI or arXiv id typed into 발견 근거, the app asks `doi.org` for CSL JSON. The DOI's registration agency (Crossref, DataCite with arXiv, mEDRA, JaLC, KISTI) has the title, authors, year, journal and abstract from the day the DOI is registered; OpenAlex indexes new papers days or weeks later. Such records show `doi.org 서지 사용 · OpenAlex에 아직 없음` and have no citation links until OpenAlex has the paper and the paper's related, reference or citing list is opened. Shelf indexing does not call doi.org.
- **`확인 필요 다시 조회` reads the PDFs again.** It used to repeat the lookup with the identifiers found at the first indexing, so arXiv PDFs indexed before 0.3.20 need this button once to pick up their stamps. Files confirmed with `파일명 서지 유지` are left alone.
- Manual lookups no longer send PubMed a request for papers without a PMID. `Usage.md` explains `확인 필요` and how to settle it.

Library schema stays at 3.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **296 passed, 0 failed** across 35 files, including two new shelf tests: arXiv id parsing, stamp extraction and particle matching, and an indexing run where an arXiv stamp resolves a renamed preprint, a merged record is found by its location DOI, co-author and particle filenames are accepted by title, `확인 필요 다시 조회` reads a PDF again, a typed arXiv id reaches OpenAlex as its DOI and a paper missing from OpenAlex is filled from a doi.org CSL record. Crossref CSL mapping (JATS abstract, page range) is checked on its own.
- Live checks on scratch libraries with the real OpenAlex and doi.org: a rotated arXiv margin stamp was read from a PDF; `arXiv:2610.27099v1`, an arxiv.org link with a version and `hep-th/9901001` all resolved; the resolver accepted the screenshot's Ramstead, Modirshanechi, Olson-Urtecho and de Koning files by title, Liu's renamed preprint by its stamp and "Attention Is All You Need" through its merged record, and left Pradelli (retitled bioRxiv preprint) unresolved. Six q-bio.NC preprints and four Crossref articles from this week were all missing from OpenAlex; `arXiv:2610.37327v1` and `https://doi.org/10.1002/ohn.70500` were filled from doi.org with title, authors, year, venue and abstract, and an unregistered DOI reported that neither service knows it.
- Packaged app: the DMG's checksum is valid and strict signature verification passed for the bundle inside the `.tar.zst` (0.3.20). The packaged smoke test passed on the extracted bundle with a restricted PATH (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion). The packaged service and PDF worker contain the arXiv DOI prefix and the CSL JSON request, and the renderer the new lookup label.
- Not checked: the installed app's own window, and `확인 필요 다시 조회` on the real shelf.

## Known issues

- The first passage search after launch takes about 2.5 s while the in-memory sign bits load, and the service does not answer other requests during that time.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261028-215239-arxiv-doi-0.3.20` (integrity ok, schema 3, **12,367 works**, **9,203 attachments**, **9,238 shelf files**, 6 projects, matching the live library). The replaced 0.3.19 bundle is kept there as `ResearchBunny-0.3.19-installed.app` (signature verified). `passages.sqlite` was not copied: 0.3.20 does not change it, and the 0.3.18 backup holds a clone.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.20** (bundle hash `1i0a8az2eqry7`); all **242 files** match the package and strict signature verification passed. The app was not running and was not launched.
- Files already in `확인 필요` keep their state until 설정 → 서고 → `확인 필요 다시 조회` is pressed once.

Artifacts, built from `1943b13`: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` (SHA-256 `962f995f…ffcbaf19`) and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst` (`a81f9981…a902838d6`), also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.20/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
