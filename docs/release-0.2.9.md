# ResearchBunny 0.2.9 · 2026-10-03

## Changes

- Open attached articles in the embedded PDF reader. Switch between Browse and Full text while retaining the list state and PDF page/zoom; choose among multiple attachments.
- Keep AI conversations separate by project, article and abstract/PDF attachment. Store all questions, answers, streaming checkpoints and immutable context snapshots in SQLite. New conversations preserve history; selected threads reopen after switching and restarting.
- Add the AI sidebar with Markdown replies, cancellation, retries, history and optional literature search. Support Ollama Cloud, Codex subscription and explicitly selected OpenAI API providers; preserve existing provider settings and store new credentials in Keychain.
- Package PDF.js workers, fonts and rendering resources locally, validate attachment access in the backend and use bounded native RPC chunks. Retain existing backup/restore and permanent-deletion semantics for AI history.

Implementation and feature QA: [AI sidebar](ai-sidebar-plan.md), [article reader](article-reader-plan.md).

## Release validation

- Version `0.2.9` in the package manifest, lockfile and installed app bundle.
- `bun run typecheck`, `bun run lint` and `git diff --check` passed.
- Full integration suite: **139 passed, zero failed** across 17 files.
- Stable package built successfully. The extracted distribution passed the restricted-PATH packaged runtime check, including PDF chunks, separate durable context threads, history selection, import, export, backup/restore and permanent deletion.
- `codesign --verify --deep --strict` passed for the wrapper, extracted bundle and installed app. `hdiutil verify` passed for the DMG. The wrapper's embedded archive matches the published local archive by SHA-256.
- Replaced `/Applications/ResearchBunny.app` and launched it. The installed bundle reports `0.2.9`; all **441 files** match the validated package. Native WebKit loaded the existing library and displayed the new Browse / Full text controls and Literature / AI tabs. Further installed-app UI input stopped when the UI tool detected user changes. PDF rendering and context switching were already verified in the isolated native QA build; see the article-reader record.
- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261003-215852-article-reader-0.2.9` before replacement. After launch, all pre-existing table hashes were unchanged (**2,036 works, 104 attachments**); all **104 attachment file hashes** matched. SQLite integrity passed. Only the three new AI-history tables were added.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local verification logs are under `.qa/release-0.2.9/` (not committed).

## Limits

macOS Apple Silicon, native WebKit. Local ad-hoc signature; no Developer ID signing or Apple notarization. OCR and visual interpretation of PDF figures are not included. Live AI-provider inference has not been tested; automated and UI inference checks use synthetic responses. PDF extraction and provider input limits are disclosed in the reader and sidebar.
