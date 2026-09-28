# Archive Classification

User request (2026-09-28): use the configured LLM to organize each project's saved archive into at most ten subtopics, displayed as folders beneath the archive. Manual collections remain available in a collapsed secondary section.

## Behavior

- Classify every included paper in the current project, independent of the visible page, query, or filters. Pending, excluded, and trashed papers are not sent.
- Use the existing Codex subscription or OpenAI provider and AI opt-in. Send titles, available abstracts, topic names, and the project question. Do not send PDFs, private notes, tags, or file paths.
- Retain all titles and reduce the abstract excerpt length uniformly when needed to respect the existing input budget. Reject before calling if the complete archive cannot fit. Output uses compact numeric indexes rather than UUIDs.
- Accept 1-10 nonempty topics with unique names. Require each supplied paper exactly once, and reject missing, duplicated, or foreign indexes.
- Apply a complete, validated result in a transaction. Cancellation, provider errors, interrupted app sessions, or changes to archive membership/metadata leave the previous tree intact.
- New saved papers appear under Unclassified until the next explicit classification. Classification makes one AI request; it does not start hidden recurring requests.
- On each button-triggered update, send the existing topic names/descriptions and each paper's previous assignment. Prioritize unclassified papers, preserve existing groups when appropriate, and allow merging or adding categories while validating the complete final partition against the same ten-topic cap. Classified papers supply titles and assignments; new papers also supply available abstract excerpts and provider topic metadata within budget.
- The model explicitly identifies retained topics by index. Retained or renamed topics keep their IDs and palette slots; a merged topic retains one existing identity. New topics use an available palette slot. Invalid or duplicate retained-topic references are rejected.
- Graph and timeline nodes can use topic colors, with matching sidebar folder icons and a labeled legend. Unclassified saved papers are gray. Seed shapes and selection borders remain distinct. A checkbox switches back to status colors without moving nodes or losing selections.
- Topic membership is separate from manual collections and original files. Counts and topic views include only currently archived papers. Trash restore restores visibility; permanent removal cascades membership. Merge, merge undo, and backups preserve topic data.
- Every topic uses the same icon/text/count columns and indentation. The sidebar divider supports pointer drag, arrow keys, double-click reset, and persisted width with responsive limits.
- SQLite schema 2 adds topic and membership tables; schema 1 backups remain restorable. Prior schema 1 app builds cannot open a migrated library.

## Verification

Focused integration tests cover full coverage, invalid output, privacy, provider routing, project isolation, filters, new papers, cancellation, stale input, budgets, interruption recovery, merge/undo, trash, backup restoration, and navigation persistence. The existing complete integration suite and packaged runtime smoke test remain required.

Verified on 2026-09-28:

- Full integration suite: 70 passing tests. TypeScript and ESLint pass. Tests include button-only incremental updates, merging/creating topics at the ten-topic cap, stable topic identities/colors, and graph color toggles without position or selection loss.
- Live Codex classification: 67 saved papers into 9 topics and 76 into 8, with zero missing or duplicate assignments. Classified copies were checked against original metadata fingerprints before applying the topic tables.
- Native installed app: topic selection opens the matching papers; all topic icons, labels and counts align; the sidebar separator responds to keyboard input (260 to 280 px) and pointer dragging (280 to 341 px).
- Updated installed app: the redundant clear-all-selection toolbar button is absent; all 76 archive nodes render with the eight matching folder/legend colors. Existing page-selection checkboxes remain available. No live reclassification was triggered during this update verification.
- Stable artifact runtime: PDF extraction, archive, export, backup/restore and deletion smoke test passed with restricted PATH. Test the unpacked `stable-macos-arm64-ResearchBunny.app.tar.zst` payload; the outer stable app is a self-extracting launcher and has no directly accessible Bun executable.
- Local ad-hoc signature verification passed. Developer-ID notarization was not performed.
