# ResearchBunny 0.2.1

2026-09-28 · macOS Apple Silicon local release

## Changes

- Treat the review inbox as a temporary collection. Clear every pending item independently of filters or pagination, with undo. A new keyword, identifier, semantic, or AI search starts a fresh inbox; expansion, resume, and additional pages retain it.
- Preserve paper metadata, notes, PDFs, saved/excluded/trash decisions, seeds, other projects, and exploration history when clearing. Rediscovered pending candidates return to the inbox.
- Display the new-collection action and manual collections as indented children of the manual-collections section.
- Include the accumulated archive topic classification, stable topic colors, graph layout/selection and citation diagnostics, resizable sidebar/inspector, selection/filter, settings, and application-credit improvements. See `archive-classification.md` for classification behavior and prior verification.

## Verification

- TypeScript and ESLint passed; the complete integration suite passed 72 tests during this release session.
- Isolated native QA: three pending papers cleared to zero and restored to three with undo; collection hierarchy inspected visually.
- Stable tar payload: restricted-PATH packaged PDF extraction, archive, export, backup/restore, and permanent-deletion smoke test passed.
- DMG checksum verification passed. Its app contents matched the stable build. Deep strict local signature verification passed for the wrapped app, unpacked payload, and installed application.
- Installed the app from the DMG at `/Applications/ResearchBunny.app`, launched its self-extracting wrapper, and confirmed stable version 0.2.1. The existing project reopened with its archive and topic groups; the new clear-inbox action is present.
- Compared nine core library tables before and after installation: contents and counts matched exactly. No actual inbox was cleared during installation verification.
- The previous app is retained at `/Applications/.ResearchBunny-before-0.2.1.app`; the pre-install SQLite backup and local verification manifest are under ignored `artifacts/release-0.2.1/`.

## Artifacts

- `out/electrobun/stable-macos-arm64-ResearchBunny.dmg`
- `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`
- `out/electrobun/stable-macos-arm64-update.json`

The app and DMG use local ad-hoc signatures. Developer ID signing and Apple notarization were not performed.
