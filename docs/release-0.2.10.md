# ResearchBunny 0.2.10 · 2026-10-03

## Changes

- Replace the project initial badge, native select and separate plus button with one project switcher. Show the current project with a check and allow long names to wrap in the menu.
- Create a project directly from the menu with a required name and an optional, collapsible research question. Retain drafts after dismissal or errors and prevent duplicate submissions.
- Support keyboard navigation and focus restoration. Preserve selected papers and sorting when switching projects, and truncate long project names in the sidebar and breadcrumb.

Design and interaction checks: [project switcher](project-switcher-plan.md).

## Validation and installation

- Typecheck, lint and `git diff --check` passed. Integration suite: **139 passed, zero failed** across 17 files.
- The stable package and Safari 17 renderer build succeeded. The extracted app passed the restricted-PATH packaged runtime test for PDF reading, conversation history, import/export, backup/restore and deletion.
- The wrapper, extracted app and installed app passed strict code-signature verification. DMG checksum verification passed, and the wrapper's embedded archive matches the published archive.
- Replaced `/Applications/ResearchBunny.app` with version **0.2.10**. All **441 files** match the validated distribution.
- Opened the installed app against the existing library. Native WebKit displayed the new project menu and inline creation form; name input, optional research-question expansion, cancellation and Escape focus restoration worked. No test project was saved to the real library.
- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261003-223238-project-switcher-0.2.10`. Library integrity, all existing core-table hashes (**2,036 works**) and **104 attachment hashes** were preserved after installation.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`. Local validation logs are under `.qa/release-0.2.10/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
