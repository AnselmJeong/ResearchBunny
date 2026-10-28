# ResearchBunny 0.3.18 · 2026-10-28

## Changes

- **Search the shelf PDFs' full text by passage.** The first step from reference manager toward a research app that answers from evidence. Shelf search gains a **논문 / 본문 구절** toggle. **본문 구절** finds paragraph-sized passages inside the shelf PDFs instead of whole papers:
  - Passages are grouped under their papers, at most three per paper, with the search words marked. The page badge (`p. 4`) opens the reader at that page; the section name shows where the passage sits.
  - Word search and meaning search are fused, so a question in Korean finds the English paragraph that answers it. Word matches count only when a passage holds at least half the query words.
  - A folder scope limits the search to that folder's papers.
- **The shelf's body text index.** Every shelf PDF is split into passages of about 1,400 characters with their pages and sections. Running heads, page numbers, side stamps ("Downloaded from …"), acknowledgements, conflicts of interest, author contributions, data availability and everything after the references are left out. Passages are embedded with the shelf's local Ollama model, so indexing uploads nothing.
  - The index is `~/Library/Application Support/ResearchBunny/library/passages.sqlite`, separate from the library and rebuildable. It is keyed by each PDF's content, so moving or renaming a file does not index it again; PDFs the app no longer shows lose their passages on the next pass.
  - The whole shelf was indexed before this release from the command line (9,016 of 9,055 PDFs, 417,730 passages, 1.4 GB, 4 h 49 min). This version continues from that file: after each shelf scan it indexes only new PDFs.
  - 설정 → 서고 shows **본문 색인**: PDFs and embedded passages, scans without text and unreadable PDFs, with **일시정지**, **재개** and **지금 이어서 색인**. A pause is kept across launches.
- **The reader opens at the requested page.** A short PDF could open at page 1 instead of its saved page, because the reader missed the layout event or the scroll was dropped while the zoom was fitting. It now retries until the page is actually in view; this also serves the passage page links.
- **AI features may send paper text.** PRD: answers and reports send the supporting paper text (passages or full PDF text) to the connected Codex or Claude account. Private notes still need their own opt-in. Nothing in this release sends passages yet; cited answers come next.

Design, chunking rules, storage, measurements and next steps: [본문 구절 색인](passages.md).

Library schema stays at 3. An older app ignores `passages.sqlite`.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **294 passed, 0 failed** across 35 files, including 4 passage tests: chunking a generated multi-page PDF (running heads, folios, a rotated stamp, back matter, references, hyphenation, a paragraph across pages, sections and pages), chunk packing, the store (sign-bit scan plus int8 rescoring equal to brute force, scopes, an unusable file set aside, lexical search), and the app end to end with a stand-in Ollama (indexing after a scan, page and section in results, folder scope, word-coverage rule, hidden PDFs dropped, the lock against a second indexer, pause and resume).
- Chunk quality on 16 real shelf PDFs: about 3.15 passages and 3,650 characters per page.
- Real shelf, read only except `passages.sqlite`: English and Korean questions (lithium relapse, not-just-right experiences in OCD, accelerated TMS, BDNF Val66Met, ketamine, 도파민 보상 예측 오류, 강박장애의 불완전감) returned the expected papers' Results and Discussion passages. A search takes 70–260 ms including the query embedding.
- Browser harness (scratch library of four generated papers, the real React UI and service): passage results, opening the reader at a passage's page and moving to another page in the open PDF, and the settings status.
- Packaged app: the DMG's checksum is valid and strict signature verification passed for the DMG's app and for the bundle inside the `.tar.zst` (both 0.3.18). The packaged smoke test passed on the extracted bundle with a restricted PATH (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion). The packaged service contains `passageSearch` and `passages.sqlite`, the renderer the **본문 구절** toggle, and the packaged PDF worker split a 23-page review from a library backup into 26 passages under its numbered sections.
- Not checked: the installed app's own window with the real shelf. The shelf volume (`/Volumes/LIBRARY`) was not mounted at installation time.

## Known issues

- The first passage search after launch takes about 2.5 s while the in-memory sign bits load, and the service does not answer other requests during that time.
- 36 PDFs could not be read (encrypted, damaged or timed out) and 3 scans have no text layer; they have no passages.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known. Quitting now also waits for a running passage pass to stop.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261028-194918-passages-0.3.18` (integrity ok, schema 3, **12,232 works**, **9,075 attachments**, **9,110 shelf files**, 6 projects, matching the live library), with a clone of `passages.sqlite` (quick check ok, **417,730 passages and vectors**). The replaced 0.3.17 bundle is kept there as `ResearchBunny-0.3.17-installed.app` (signature verified).
- Replaced `/Applications/ResearchBunny.app` with version **0.3.18** (bundle hash `wan4fobiw6dt`); all **242 files** match the package and strict signature verification passed. The app was not running and was not launched. On its first launch with the shelf mounted, the passage pass finds every PDF already indexed and only continues with new ones.

Artifacts, built from main at `5a11a42` (PR #2): `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` (SHA-256 `13015db6…f9460da8`) and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst` (`f89e3895…ffaf85bb8`), also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.18/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
