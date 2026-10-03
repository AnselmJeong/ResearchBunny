# AI sidebar · 2026-10-03

## Scope

Turn the right inspector into Literature / AI tabs. Keep the existing literature details and add persistent conversations scoped by project and selected article. Resolve the selected article's current abstract in the backend; do not accept document text or secrets from the renderer. Missing abstracts must be visible. Stream replies, support cancellation, retain failed prompts, and show retrieved sources.

Use Ollama Cloud first and the existing isolated Codex App Server subscription client second. Retain the explicitly selectable legacy OpenAI API provider and existing credentials. Extend all AI call sites (recommendations, classification, sidebar) with Ollama routing; no automatic provider fallback. Store Ollama, OpenAlex, PubMed/NCBI and TinyFish keys only in the existing Keychain envelope. Settings include model discovery and existing Codex login/quota UI.

Search is off by default and controlled for each sidebar request. Adapt ScholarPen's OpenAlex semantic + PubMed retrieval and TinyFish Search/Fetch fallback; keep source URLs and disclose partial failures. Translate/refine the user's query with the selected provider. Document and retrieved text are untrusted evidence, not instructions.

## Boundaries

- Backend owns chat history, immutable per-turn context, search, stream and cancellation. Persist local history in the existing SQLite preference store; ephemeral Codex threads receive only the selected conversation. Abort on application shutdown.
- Reuse ResearchBunny's private Codex home, scratch cwd, disabled tools, quota preflight, account models, isolated workers and no API fallback. Tested CLI protocol: 0.160.0. Make structured output optional for conversational replies.
- Add a context contract whose future PDF variant requires references-excluded text. PDF viewing/extraction and reference removal remain next-session work; this session sends abstracts only.
- Source implementation and development build are in scope. No commit, push, installed-app replacement or release/version change requested.

## Verification

Run deterministic provider/search/chat integration tests, existing Codex subprocess tests, typecheck, lint, build and diff check. Test context switching, search-off isolation, cancellation, failure retention, settings preservation, credential filtering, source links and Ollama streaming termination. Inspect the actual rendered sidebar and settings with synthetic article data. Live inference depends on credentials/sign-in; do not copy credentials from another app.

## Delivered and verified

- Literature / AI tabs, per-project/article SQLite conversations, streamed Markdown replies, cancellation/retry, prompt drafts, explicit missing-abstract state, source links and search switch.
- Ollama Cloud default for new settings; explicit existing provider selections and legacy Codex defaults are preserved. Ollama also serves recommendations/classification. Cloud does not support native structured output, so schemas are supplied in the prompt and existing domain validators reject invalid results before library writes ([Ollama documentation](https://docs.ollama.com/capabilities/structured-outputs)).
- Search follows ScholarPen: OpenAlex semantic search plus PubMed verification, then TinyFish Search/Fetch when fewer than three scholarly results remain. Search is disabled by default. OpenAlex and PubMed requests reserve rate-limit slots; failed providers leave a visible notice.
- Keychain holds all API keys; only configured flags cross into settings snapshots. Codex CLI 0.160.0 schema inspected; existing isolated auth, tool restrictions, model and quota logic retained. Text conversations use optional outputSchema.
- Full integration suite: 132 passed, zero failed. After Cloud-schema and cancellation/recovery refinements, focused chat/Codex/trash suites: 44 passed, zero failed. Typecheck, lint and production renderer/development app build passed. Packaged runtime regression passed with restricted PATH (PDF extraction, archive, export, backup/restore and deletion).
- Browser UI QA used the real React UI and SQLite service with synthetic streamed/retrieved responses: selection changes, history restoration, missing abstracts, search source display, Ollama model list and Codex settings were inspected. A separately built native WebKit QA app verified the actual tabs, abstract context and missing-key setup path using an isolated library. Screenshot: `.qa/ai-sidebar-native.png`.
- No live inference was sent to Ollama/Codex and no paid TinyFish search was performed. Real account inference and Keychain credential entry still require the user's configured credentials/login. The public Ollama Cloud model endpoint was checked and includes the default `gpt-oss:120b`.
- Development artifact: `build/dev-macos-arm64/ResearchBunny-dev.app` (local ad-hoc signature; not notarized). Installed application replacement, commit and push were not requested.

## Next session: PDF reader

Use the `ArticleContext` discriminated union in `src/shared/chat.ts` as the boundary. The current resolver is `abstractContext` in `src/service/chat/context.ts`. A PDF reader should resolve its authorized attachment in the backend, extract and remove references, then provide `kind: "pdf-fulltext"`, `attachmentId`, and `referencesExcluded: true`. Do not add an IPC endpoint that accepts arbitrary local paths or lets the renderer assert that reference removal occurred. Keep each turn's context immutable and show the actual context kind in the sidebar.

The subsequent [article reader implementation](article-reader-plan.md) now supplies PDF context, separate context-scoped SQLite threads, retained history and immutable evidence snapshots. Its implementation and verification notes supersede the future-PDF boundary above. Reference removal is reported truthfully when no reliable heading is found.
