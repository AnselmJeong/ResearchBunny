# ResearchBunny 0.3.13 · 2026-10-22

## Changes

- **One paper's neighbours stay with that paper.** The **관련 논문 / 참고문헌 / 후속 인용** buttons under the detail panel used to start a full exploration and replace the middle list with its results. The list then no longer said whose references or citing papers it showed, and every result went into 검토 대기함.
  - The buttons now list the neighbours of the paper shown in the detail panel inside the panel itself. A sticky header names that paper: `참고문헌 14편 · title · first author year`. Pressing the button again, or **‹ 상세**, returns to the paper's details. The middle list does not change.
  - **참고문헌** lists every reference the paper cites, sorted **피인용순** or **최신순**.
  - **후속 인용** shows the archive and shelf papers that cite the paper first (from the library, no API call), then OpenAlex's citing papers 50 at a time with **50편 더 보기**. It sorts by citations or by date.
  - **관련 논문** groups similar shelf papers (local Ollama embeddings), PubMed neighbours (when turned on in Settings) and OpenAlex related works. A paper appears only in the first group that lists it.
- **Every row says what you already have.** Saved papers carry `✓ 아카이브`, shelf papers their folder name. Clicking a row unfolds its authors, journal and abstract with **아카이브에 저장**, **DOI** and **이 논문 보기**.
- **Follow a chain and come back.** **이 논문 보기** opens that paper in the detail panel and leaves a `‹ 참고문헌 · original title` line at the top. Clicking it returns to the original paper's list at the same scroll position, with the same row unfolded, and the opened paper's badge shows whether you saved it there. The chain can go several papers deep.
- **Select, save, collect.** Right-click a row (or tick its box) to select it; right-click again clears it, and shift + right-click selects a range, as in the middle list. A bar then offers **아카이브에 저장** and **컬렉션에 저장…**. **+ 새 컬렉션 만들기…** fills in a name such as `Lodge 2024 참고문헌`. Papers added to a collection are saved to the archive too.
- **Nothing reaches the review queue until you save it.** Listed papers are stored so they can be opened and saved, but they join the project only when saved or collected.
- **The full exploration is one click away.** **탐색으로 열기** above each list runs the previous exploration in the middle list, with filters, the graph and more API pages. Those results still go to 검토 대기함.
- The detail panel's **관련 문헌** tab is gone: its similar shelf papers are the first group of **관련 논문**, with the same **다른 폴더만** option, and its citation links are the badges and the first group of **후속 인용**.
- API use: the first opening of a list usually costs 1–3 OpenAlex calls (references are fetched 100 per call, and only the ones not stored yet). Opening it again uses stored papers and the OpenAlex cache.
- Usage.md has a new section, **상세 패널에서 한 논문의 이웃 보기**.

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **216 passed, 0 failed** across 24 files, including 7 new tests for the lists (`tests/integration/links.test.ts`): references fetched once and only when missing, citing papers paged and sorted with the archive first, related groups without repeats, papers without identifiers, DOI-only papers looked up first, budget errors, and the service command. Each test also checks that listing adds nothing to the project.
- Browser harness (scratch library, 4-PDF shelf with fake Ollama, a 5-paper archive, OpenAlex and PubMed stubbed; a paper with 14 references, 5 related works, 4 PubMed neighbours and 120 citing papers), driven in the built-in browser:
  - 참고문헌 listed 14 papers inside the detail panel with the parent paper in a sticky header; the middle list stayed on 내 아카이브. The two saved references showed `✓ 아카이브`. 최신순 re-sorted the list.
  - Right-click and shift + right-click selected rows; a new collection named `Author 8100 1995 참고문헌` received four papers. 내 아카이브 went from 5 to 9, 검토 대기함 stayed at 0, and the 10 unsaved references did not join the project.
  - 이 논문 보기 opened a reference with a `‹ 참고문헌 · title` line; going back restored the list at the same scroll position (200 px) with the same row unfolded. Saving the reference in its own details and going back showed its `✓ 아카이브`.
  - 후속 인용 put the archived citing paper first, then loaded OpenAlex's 120 citing papers 50 at a time; 최신순 started again from the newest.
  - 관련 논문 showed 4 shelf papers with similarity bars and folder names, 4 PubMed neighbours and 4 OpenAlex related works; the paper listed by PubMed was not repeated under OpenAlex.
  - A failed load showed the error with 다시 시도, which then loaded the list. Choosing another paper in the middle list closed the list and the trail. 탐색으로 열기 opened the 참고문헌 exploration in the middle list as before.
  - The light and dark themes were checked; the selection bar no longer overflows the 340 px panel.
- Packaged app: strict signature verification passed, and the packaged smoke test passed (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion with a restricted PATH).
- Not checked: the lists against the live OpenAlex and PubMed services, and the installed app's own window.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261022-224456-inspector-links-0.3.13` (integrity ok, schema 3, **12,191 works**, **9,022 attachments**, **9,057 shelf files**, 6 projects, matching the live library). The replaced 0.3.12 bundle is kept there as `ResearchBunny-0.3.12-installed.app`.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.13**; all **242 files** match the package and strict signature verification passed. The app was not running.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.3.13/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
