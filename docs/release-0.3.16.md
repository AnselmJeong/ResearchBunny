# ResearchBunny 0.3.16 · 2026-10-26

## Changes

- **Claude subscription connection.** 설정 → AI 연결 → **Claude (Claude subscription)** runs the installed Claude Code CLI (2.1.273 or later) with ResearchBunny's own sign-in folder (`~/Library/Application Support/ResearchBunny/claude`), separate from your usual Claude Code login and outside backups. Press **Claude 계정으로 로그인** once; the CLI opens the browser sign-in. It answers without tools, MCP or hooks, stops on any quota or overage signal and never falls back to a paid API. Recommendations, classification, seed queries, inbox sorting and the AI sidebar can all use it. Models: account default, Opus, Sonnet, Haiku. Details: [Claude 구독 연결](claude-subscription.md).
- **계보 리포트 (genealogy reports).** **계보 리포트** in a collection's header turns that collection into a chaptered review of how its research question arose, developed, branched, which branches hit a wall and which survived. Reports appear in the sidebar under **계보 리포트**.
  - Steps: 자료 준비 (OpenAlex records, open-access PMC full text from Europe PMC, paper types from PubMed, OpenAlex and the model, missing PDFs through the archive's full-text job, reading text cut by type) → 문헌 카드 (evidence quotes checked against the text) → 공백 점검 (shared references, earlier work the cards mention, recent citing works) → 가지 장부·목차 (branch ledger and detailed `00_contents.md`, waits for **승인하고 집필 시작**) → 집필 (one section at a time) → 검증 (the genealogy skill's checklist) → 렌더.
  - Output in the report's folder (by default inside the library; a ScholarPen project folder can be chosen): `cards/NNN_citekey.md`, `00_contents.md`, `NN_장제목.md`, `부록A_가지_장부.md`, `<제목>.bib` with only the cited papers, and `build/<제목>.epub` and `.pdf` with numbered (Vancouver-type) citations. EPUB needs pandoc; PDF needs pandoc and typst (`brew install pandoc typst`). Without them the Markdown and bib are still written.
  - New papers: in **자동 채택** mode (default) the gap check adopts relevant candidates within its budget (3 rounds, 15 per round, up to 50% over the starting collection), finding them in the archive, then the shelf, then OpenAlex, and cards them. Sources the writer asks for are found the same way and only the sections that asked are rewritten. **제안만** leaves them in the **추가** tab. Every added paper keeps its reason and can be undone.
  - Each step can use its own connection and model: Codex, Claude or Ollama. Reports never use the paid OpenAI API.
  - The outline and chapter files can be edited in the app or elsewhere; edited chapters are not overwritten (a new version goes beside them as `.rb-new.md`).
  - Design: [계획](genealogy-report-plan.md). Implementation and validation by milestone: [구현 기록](genealogy-report.md).

Library schema stays at 3. The genealogy tables are side tables, so an older app still opens the library and ignores them.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **280 passed, 0 failed** across 32 files, including 23 Claude connection tests with a stand-in CLI and 34 genealogy tests (AI layer, preparation, cards, gaps and outline, writing with a real pandoc 3.11 and typst render, automatic expansion).
- Claude Code 2.1.296 on this Mac: version check and the signed-out state with an empty sign-in folder, and the generation flags are accepted (`tools: []`, `mcp_servers: []`). No answer from a signed-in account was checked.
- Browser harness (scratch library, the real React UI and service, real OpenAlex, Europe PMC, PubMed, pandoc and typst; a stand-in model answered every AI call): six psychedelics papers went through every step to a 4-page PDF with a table of contents, numbered citations and Vancouver references; an automatic round adopted three OpenAlex papers within the 50% budget and rewrote only the section one of them was placed in.
- Packaged app: strict signature verification passed for the DMG's app and for the bundle inside it (both 0.3.16), and the packaged smoke test passed on the extracted bundle (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion with a restricted PATH). The packaged service and renderer contain the genealogy and Claude commands.
- Not checked: a report written by a real model (Codex gpt-6.1 or Claude), and the installed app's own window.

## Known issues

- Papers imported from OpenAlex get citekeys from the first author's given name (`Robin2014The`), which genealogy reports show in their Markdown. A fix for new papers is being worked on separately; existing keys will not change.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7. Its cause is not known yet, and this release does not change the quit path.

## Installation

- Not installed. `/Applications/ResearchBunny.app` is still 0.3.13.

Artifacts: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst`, also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.16/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
