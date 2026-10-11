# ResearchBunny 0.3.0 · 2026-10-11

## Changes

- Add the shelf (서고): an app-wide, read-only index of an existing PDF folder such as `/Volumes/LIBRARY/Articles`. Files are identified by SHA-256, moves and renames are followed, and nothing in the folder is moved, renamed or created. Shelf papers are global works that join a project only when saved.
- Index in resumable stages: filename records first, then hashing, page 1–2 extraction, OpenAlex metadata (DOI batches, then title search), abstracts from OpenAlex, PubMed or the PDF, and local `embeddinggemma-2` embeddings through Ollama.
- Show the shelf tree in the sidebar, shelf scopes in the list, and the folder, Finder action and metadata review in the Inspector. Add the Inspector `관련 문헌` tab with similar shelf papers and shelf papers linked by citation.
- Search the shelf first: pin `내 서고에서 찾음` above external results, badge papers already on the shelf, add a shelf filter, and add network-free `서고만 검색` and `서고에서 비슷한 논문`.
- Link shelf PDFs instead of downloading them in `PDF 원문 찾기`, and add `서고에서 연결` to the missing-PDF list. Put shelf abstracts first in AI chat evidence.
- Keep 20% of the OpenAlex daily credits for interactive searches, wait for the reported reset time, and persist the pause across restarts.
- Batch list rows, filter graph edges in SQL, compare duplicate titles without parsing full records, and trust unchanged shelf hashes. The 5,000-paper archive list p95 dropped from 208 ms to 114 ms.
- Library schema 3. Libraries opened by 0.3.0 cannot be opened by 0.2.10 or earlier.

Implementation notes, deviations from the plan and measurements: [shelf](shelf.md). Design: [shelf integration plan](archive_plan.md).

## Validation and installation

- Typecheck, lint and `git diff --check` passed. Integration suite: **172 passed, zero failed** across 19 files, including 10 shelf tests.
- The extracted stable app passed the restricted-PATH packaged runtime test.
- Shelf performance on a synthetic 10,000-paper shelf with 500,000 citations: 400-paper folder list 12 ms, whole-shelf list 113 ms, related papers 23 ms.
- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261011-140348-shelf-0.3.0` (integrity ok, **2,036 works**, **104 attachments**), then replaced `/Applications/ResearchBunny.app` with version **0.3.0**. Strict signature verification passed and all **441 files** match the package.
- Indexed the real shelf: 8,295 files (27 in `_duplicated` excluded), 8,212 embeddings, 7,031 of 7,157 checked files with verified metadata (98.2%). 1,138 files wait for the next OpenAlex daily budget. 115 existing archive papers received shelf PDFs through DOI merging.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
