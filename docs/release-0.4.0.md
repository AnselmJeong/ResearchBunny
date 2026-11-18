# ResearchBunny 0.4.0 · 2026-11-18

A code audit of the whole app (`fable_suggestion.md`) and the fixes that came out of it, in five stages. Nothing new to learn in the interface; what changes is what the app no longer loses, repeats or gets stuck on.

## Before the first launch

- **Every shelf PDF is read and split into passages again.** The splitter changed (see Passages), so the passage index rebuilds once. Passages whose text is unchanged keep their vectors, so only new or changed passages are embedded. How long the reading takes on the real shelf was not measured.
- Library schema stays at 3. Two indexes are added on first open. An older app still opens the library; it would split the passages back to the old form.

## Changes

### Data that was being lost or damaged

- **Merging two records keeps what only the removed one knew**: abstract, PMID, year, topics, citation count, open-access link, and its state in projects the kept record was not in. Conversations about the removed record move to the kept one.
- **Undoing a merge puts back the two records and the rows the merge changed**, not eighteen whole tables. Runs, reports and imports made since are left alone.
- **API keys**: after the Keychain could not be read, saving one key no longer replaces the others. The app reads again and refuses if it still cannot.
- **DOIs** written with TeX escapes (`\_`), without `https://`, with `%2F` or with a trailing full stop are the same DOI. BibTeX export writes DOIs and URLs as they are. A corrected DOI releases the old one.
- **BibTeX**: keys with brackets such as `S0140-6736(20)30183-5` are no longer cut, backslashes export correctly, and re-importing a .bib entry does not reset retracted, type or the provider's data.
- **Undo** skips a paper that no longer exists instead of blocking every earlier step.
- **Restoring a backup** leaves a linked PDF that is still in place as a link.

### Shelf

- A copy takes over when its primary file is deleted or moved to `_duplicated`; the paper keeps its PDF.
- A row for a deleted file no longer blocks a new file from taking its path, and one failed index update no longer stops a 수신함 정리 batch.
- Files whose dates changed but not their bytes (a copy to a new disk, a sync tool) keep their record and are not looked up again. Records chosen by hand are not resolved again.
- An I/O error during a scan stops the scan instead of marking the file missing.

### Passages and answers

- **Text after a reference list is indexed** when a real heading follows: Methods printed after the main text, appendices, the next chapter of an edited book.
- A passage names every page it runs onto. Very long PDFs are marked as indexed in part; PDFs over 200 MB are left out.
- A reading that runs out of time is tried again (three times) with a limit that grows with file size, instead of being recorded as a broken PDF.
- A search limited to a folder applies the folder before the keyword ranking. `.05` and `0.05`, `1,234` and `1234` are the same number when an answer's figures are checked.
- One input the embedding model refuses no longer holds back everything after it.

### Downloads and discovery

- Background recovery of finished downloads no longer makes the app say a job is in progress.
- A PDF found through a page's ordinary links must match the paper's DOI or title before it is attached.
- A seed OpenAlex does not know yet is left unresolved instead of failing the run on every resume.
- PubMed results carry the publication year and the record's own DOI.

### Reports

- A provider that is down stops the cards step and leaves the papers to be read on the next run; dropped connections are retried; an Ollama rate limit pauses.
- Editing the outline puts 집필, 검증 and 렌더 out of date. A refused outline save keeps the draft.
- A chapter file is written even when a run stops mid-chapter.
- Shortcuts (⌘S, ⌘A, ⌘E) no longer act on the list hidden under a report.

### Start, stop and diagnostics

- A log at `logs/researchbunny.log` in the app's data folder, with key-like values removed.
- A service that cannot open the library says why; restarts back off and stop after five instead of repeating every second.
- Quitting waits for the library to close before the service is ended.

### Less repeated work

- Only commands that change something make the window load everything again.
- Compiled SQL statements are reused; sidebar counts are one query; a shelf scan writes only changed files; a record seen again adds no snapshot.
- Codex and Claude sign-in checks stand for a minute across requests. Chat answers are written once a second while streaming.
- Papers that join an arranged graph are fitted in without moving the rest.

## Not done

Listed in `fable_suggestion.md` and left for later: the list cache, a smaller graph payload, splitting `App.tsx`, list virtualization, PDF streaming, a PDF worker pool, running Codex requests in parallel, and turning backup, restore and export into cancellable jobs.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **378 passed, 0 failed** across 41 files (341 before the audit).
- The real renderer was run in the built-in browser pane against the real service on a scratch library (300 synthetic papers and a finished report): report shortcuts, outline save and its invalidation, manuscript rendering, the chat pane, which commands cause a reload, sidebar counts, and a paper joining the graph.
- A QA package was launched in the background on a scratch folder: the window exchanged commands with the service, quitting took about 0.2 s and left no write-ahead log.
- Not checked on real data: re-indexing the real shelf, Methods sections of real journal PDFs, timeouts over SMB, the Keychain refusal, Codex and Claude runs, and what the window shows when the service restarts.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261118-194026-audit-0.4.0` (quick check ok, schema 3, **13,192 works**, **9,960 attachments**, **9,997 shelf files**, 9 projects, matching the live library; 2.7 GB). The replaced 0.3.28 bundle is kept there as `ResearchBunny-0.3.28-installed.app`, and was also moved to the Trash.
- Replaced `/Volumes/Aquatope/Applications/ResearchBunny.app` (where the app is installed; there is none in `/Applications`) with version **0.4.0**, bundle hash `5e7248pucxx6`; all **242 files** match the package and strict signature verification passed. The packaged smoke test passed on the same bundle. The app was not running and was not launched afterwards.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
