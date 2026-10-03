# Article reader and durable AI threads · 2026-10-03

## Implementation boundary

- Add an in-app PDF article view with an explicit Browse / Full text switch. Preserve browsing filters, selection and scroll while reading; preserve PDF page and zoom when returning. Reuse PDFie's fit-width, selectable text and page-navigation principles with ResearchBunny's installed PDF.js engine.
- Read only registered attachments, checked against the selected work and project. Transfer bounded chunks over the existing native RPC and package the viewer worker/fonts locally.
- Extract the full PDF in the isolated worker, separately from the existing first-page metadata extraction. Detect a standalone references heading conservatively, disclose undetected boundaries, scanned pages and extraction limits. Never fall back silently to abstract context.
- Scope AI sessions by project, work and context (abstract or attachment). Resolve immutable PDF context in the backend. Keep requests running in their own threads when the UI changes.
- Store threads and message/context snapshots in SQLite, checkpoint streaming replies, preserve old threads when starting a new conversation, and offer history selection. Import existing SQLite preference conversations without removing the originals. Include threads in existing backup/restore and explicit permanent-deletion behavior.

## Verification

Exercise full-text extraction and attachment authorization; thread/context isolation, restart recovery, stream checkpoints and history preservation; run typecheck, lint, integration tests and build. Inspect actual UI switching and PDF rendering using synthetic data. Preserve pre-existing work; no commit, push, release or installed-app replacement is requested.

## Verified result

- PDF opens from an attached article's list entry, the Browse / Full text switch, or its attachment in Literature details. The browser list stays mounted. Page and zoom preferences are scoped to the attachment; multiple attachments have a selector.
- Reader data crosses the existing native RPC in chunks no larger than 512 KiB. Work/project membership, attachment ownership, file format, size and content hash are checked. PDF.js, worker, fonts, CMaps, WASM and ICC resources are packaged locally; remote viewer resources are not needed.
- AI threads are stored in `chat_threads`, the last selected thread in `chat_heads`, and immutable per-turn evidence in `chat_contexts`. Evidence text stays in the backend/DB instead of being retransmitted to the sidebar for each token. Every published response checkpoint is persisted first. New conversations retain prior history; the history selector also restores the chosen thread after context switching. Existing preference-based conversations are imported once and their original rows retained.
- Full integration run: **139 passed, zero failed**. After final thread-selection/persistence refinements, focused reader/chat/trash suites: **22 passed, zero failed**. Typecheck, lint and diff checks passed.
- Browser UI with the real SQLite service and synthetic streaming responses verified PDF versus abstract history, switching during a response, starting a new thread and reopening the previous one. Native WebKit in an isolated QA app rendered PDFie's two-column and multi-page fixtures and retained **page 2 / 125% zoom** across Browse / Full text switching. Dark-theme contrast was checked and corrected.
- The packaged runtime test passed with restricted PATH, including the new PDF chunk RPC, distinct abstract/PDF threads, thread history, existing PDF extraction/import/export, backup/restore and permanent deletion.
- Development artifact: `build/dev-macos-arm64/ResearchBunny-dev.app`. Local ad-hoc signature; no installed-app replacement, release, commit or push.

## Explicit limits

The viewer accepts files up to 100 MiB. AI extraction uses the isolated worker with a 60-second timeout, 500-page and two-million-character limits; over-limit or unreadable PDFs fail explicitly and retain the question. OCR and visual understanding of figures are not included. Reference-section removal uses a conservative standalone-heading heuristic and discloses when the boundary cannot be found. Existing provider input limits still apply; full text is never silently shortened to fit them. Live AI-provider inference was not exercised; UI inference used synthetic responses.

## Follow-up release

The user subsequently requested a version bump, commit, push and installed-app replacement. See [0.2.9 release validation](release-0.2.9.md) for that separately authorized delivery.
