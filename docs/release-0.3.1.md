# ResearchBunny 0.3.1 · 2026-10-11

## Changes

- Change the shelf folder from Settings. A preview shows what stays before anything changes: a remounted or moved shelf and a wider parent folder keep the whole index (ids, metadata, embeddings, no new lookups), a subfolder keeps only its files, and an unrelated folder is indexed from scratch. Files are never moved or deleted; project papers linked to PDFs that leave the index keep opening them at their old location. Indexing is stopped for the change instead of refusing it, and project-paper links to shelf PDFs now follow the new location too ([shelf](shelf.md#서고-위치-바꾸기-031)).
- Store every PDF the app obtains in the shelf inbox (the shelf root) as `연도 - 저자 - 제목.pdf`; identical bytes already on the shelf are linked instead. An offline shelf refuses downloads and imports rather than falling back to the app folder. Settings can move PDFs still kept in the app folder into the inbox ([inbox](shelf-inbox.md)).
- Add `수신함 정리`: proposed folders for inbox PDFs from local embeddings of similar filed papers and an AI check against `_system/taxonomy.json`, with moves logged in `intake.py`'s formats ([inbox sorting](shelf-sort.md)).
- `PDF 원문 찾기` links every shelf-held paper before Chrome, download-folder recovery or the network, and title matching tolerates word order, stop words and punctuation when the first author, year and DOI agree.
- The shelf list's search box is a ranked semantic (hybrid) search within the current folder; filters keep handling include/exclude words.
- Files awaiting a metadata check show `서지 확인 대기` instead of `확인 필요`.
- The graph draws only connected papers (up to 1,000), colors shelf subfolders, and lays out with d3-force; the citation-edge query no longer grows quadratically.
- The bulk-edit dialog can save into a new collection; the exploration history view is replaced by back/forward and the breadcrumb trail.

Library schema stays at 3; 0.3.0 can still open libraries used by 0.3.1.

## Validation

- Typecheck and lint passed. Integration suite: **191 passed, zero failed** across 21 files.
- New tests cover the four folder-change cases end to end (remount under another name while a scan runs, subfolder, parent, unrelated folder): file ids and embeddings kept, attachments and project links re-pathed, dropped files turned into plain links, shelf-only works removed, no OpenAlex calls for kept files, and the folder listing unchanged. Path mapping is tested with decomposed (NFD) Korean folder names.
- Folder changes on a synthetic 8,300-file shelf with realistic identifier, snapshot and candidate tables: remount 0.6 s (60 s before the new indexes), unrelated folder 0.7 s (over 69 s before). New indexes on `attachments` (`shelfFileId`) and on `work_id` in the tables referencing works; schema version unchanged.
- The real renderer was checked against a synthetic shelf: the remount preview and change, the warning for an unrelated folder, typing a subfolder path, and the sidebar tree after narrowing.
- The extracted stable app passed the restricted-PATH packaged runtime test and strict signature verification.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261011-213654-shelf-folder-0.3.1` (integrity ok, schema 3, **10,121 works**, **8,342 attachments**, **8,348 shelf files**). The replaced 0.3.0 bundle is kept there as `ResearchBunny-0.3.0-installed.app`.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.1**; all **441 files** match the package and strict signature verification passed. The installed app opened the existing library and created the new indexes.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.3.1/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
