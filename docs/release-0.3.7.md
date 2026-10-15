# ResearchBunny 0.3.7 · 2026-10-15

## Changes

- **Downloaded PDFs are searchable by meaning within seconds.** With a shelf connected, every PDF the app downloads or imports is stored in the shelf inbox. Text extraction and embedding then waited for the next 30-minute scan. Until that scan, the paper matched only by its words. This applied to the shelf search box, the shelf hits of a related search and the shelf abstracts sent with an AI chat question, which all use the same search. It was also left out of the similar papers in `관련 문헌`.
  - **A short pass after storing.** 3 seconds after the app stores a new PDF, a pass extracts and embeds the files waiting in the index. It does not walk the shelf folder, so a large NAS shelf is not re-read. A PDF the app stores is already matched to its paper, so the pass makes no OpenAlex calls for it.
  - **Downloads in a row.** Each new PDF restarts the 3-second wait, so a burst of downloads is handled in one pass. A PDF stored while a scan is running gets its own pass when that scan ends.
  - PDFs copied into the shelf folder by hand are still found by the 30-minute scan or `다시 스캔`.
- **The sidebar shows embedding progress.** The label next to `서고`, where the paper count usually sits:
  - `임베딩 1/2` while papers are being embedded, including the embedding step of a full scan.
  - `임베딩 대기 N` in muted text while papers are waiting. This covers the few seconds after a download, and also the time Ollama is off or its model is missing. Hovering over the label shows the shelf status, including why embedding is waiting.
  - The paper count again once everything is embedded.
  - After a pass, the status line in the shelf view adds `새로 임베딩 N편`.
- **Embedding counts no longer drop to 0.** Settings showed `임베딩 0 / N` at the start of every scan and whenever Ollama was off, even with every vector stored. Counts now use the last verified model, as search does. The total also includes files not yet extracted, and it counts duplicate copies of a paper once.

Library schema stays at 3. Nothing stored changes, and an older app reads the library as before.

## Validation

- Typecheck and lint passed. Integration suite: **204 passed, 3 failed** across 23 files.
  - The 3 failures are the single-instance lock, Keychain and service IPC tests. They need the macOS native helpers. The run was on Linux, where the Swift helpers cannot be built, and the same 3 fail there without this change.
- New test, using the real PDF worker and a fake Ollama:
  - A PDF stored after the first scan shows as `임베딩 대기 1`.
  - Within seconds it is embedded from its abstract, without a walk. A PDF dropped into the folder by hand at the same time is not indexed.
  - The scan closes with `새로 임베딩 1편`, and the label returns to the paper count.
  - With Ollama off, the next stored PDF stays `임베딩 대기 1`, and the closing message names Ollama. Stored vectors still count as embedded.
- Not yet checked on a Mac: the label in the real renderer, the packaged app, and the timing on the NAS shelf.
