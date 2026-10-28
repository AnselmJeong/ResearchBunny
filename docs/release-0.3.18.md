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
- Not checked: the installed app's own window with the real shelf.

## Known issues

- The first passage search after launch takes about 2.5 s while the in-memory sign bits load, and the service does not answer other requests during that time.
- 36 PDFs could not be read (encrypted, damaged or timed out) and 3 scans have no text layer; they have no passages.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known. Quitting now also waits for a running passage pass to stop.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
