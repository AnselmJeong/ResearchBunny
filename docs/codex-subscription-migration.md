# Codex subscription migration

## Boundary and delivery

ResearchBunny is a local Electrobun/Bun + React app. Move both AI entry points
(search planning and candidate evaluation) through an explicit provider branch.
Default new and pre-provider settings to Codex, preserving the old OpenAI model,
key, enablement, and budget settings for explicit API selection. OpenAlex search,
PDF import, bibliography, evidence validation, and library ownership stay unchanged.
Deliver source, tests, and a verified build. Commit, push, installation replacement,
and DMG distribution were not requested.

## Process and protocol

Tested CLI: 0.154.0, discovered at ~/.local/bin/codex; schema generated with the
skill diagnostic on 2026-09-28. Reference: official Codex App Server documentation
and installed generated ThreadStartParams, TurnStartParams, and account types.
Use an app-private home and scratch cwd outside the library/backup, allowlisted
environment, ChatGPT-only file credentials, disabled agent tools, and rejected
server requests. The service owns transport/auth; only safe DTOs cross IPC.
Open validated OAuth URLs in the main process, never return them to the renderer.

The installed experimental schema explicitly supports `environments: []` on
thread/start and turn/start to disable environment access. Enable experimentalApi
in the handshake and set this field on both requests. This matters because the
model catalog can expose apply_patch even when apply_patch_freeform is false.
Disable shell, image viewing/generation, code execution, apps/plugins/MCP,
permissions requests and plan/input tools as complementary controls. A real
0.154.0 thread/start accepted the no-environment request without starting a turn.

Serialize generation with abortable queue entries; each generation owns its worker
so cancellation cannot kill the login/status process. Close connecting and active
workers on shutdown/logout. Bound requests, frames, total turn and idle time.
The app owns all context; ephemeral threads receive only question/candidate data.
Use turn/outputSchema plus existing Zod/evidence checks; no images/history required
by current ResearchBunny workflows. Codex has no max_output_tokens parameter:
keep input and call limits; explicitly label output-token/dollar caps as API-only.

## Settings and subscription contract

Expose login, cancel, logout, refresh, account model catalog and quota reset times.
Keep a separate empty codexModel sentinel for the account default. Model discovery
cannot overwrite provider selection. Resolve the actual model before quota checks.
Require ordinaryUsageAllowed === true, reject unknown/malformed/exhausted applicable
windows and spend-control denial. Do not infer eligibility from purchased credits
or past reset timestamps. No paid resets, fast tier, or automatic paid API fallback.
Preflight is not an atomic billing cap; other apps share subscription allowance.
Preserve candidates and query on failures.

## Validation

Before editing: typecheck passed; baseline library/trash tests started.
Use fake subprocesses for auth, environment, pagination, stream/event order,
schema/context, failure, cancellation, shutdown and concurrent request tests.
Spy on API routing with saved sentinel keys. Verify settings round trip, typecheck,
affected integration suite, build and git diff --check. Real CLI protocol/status
and GUI checks use an isolated app home; real generation requires app-specific
OAuth sign-in and available included allowance. Record remaining unverified layers.

## Delivery evidence (2026-09-28)

- Typecheck, ESLint, all 53 integration tests, and git diff --check passed.
- 27 new Codex tests cover stream ordering/UTF-8, tool rejection, default model,
  auth/quota denial, context/schema mapping, cancellation/queue isolation, process
  failures and shutdown, no API fallback, and settings persistence. Existing
  library, PDF, backup, runtime and trash tests also passed.
- Real CLI initialization/account read reports signed out for ResearchBunny's
  separate auth home. Real thread/start accepted environments: []; no inference
  or account quota was used for this protocol check.
- `bun run build` produced `build/dev-macos-arm64/ResearchBunny-dev.app` with a
  verified local ad-hoc signature. This is not Developer-ID signing/notarization.
- Native GUI verified Codex selected by default, signed-out/login state, no Codex
  API-key input, and explicit switching to/from the API provider. A restricted-PATH
  bundled service test also verified real CLI discovery, signed-out status, and
  saved provider/account-default model after restart in a temporary data directory.
  GUI account/model/quota and real generation tests
  remain pending OAuth. No installed application replacement, commit or push.
- Existing uncommitted Electrobun migration and unrelated work were preserved.

Protocol references: https://developers.openai.com/codex/app-server and
https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/spec_plan.rs.

## Follow-up installed replacement (2026-09-28)

At the user's request, built the stable release and unpacked its signed update
archive for installation. Packaged runtime smoke checks passed with restricted
PATH (PDF extraction, archive, export, backup/restore and trash operations in a
temporary library). Replaced `/Applications/ResearchBunny.app` with version 0.2.0;
verified installed signature and backend/host hashes against the release.
The previous bundle is preserved at
`~/Library/Application Support/ResearchBunny/app-backups/20260928-181342/ResearchBunny.app`.
Native GUI launched from the installed path and showed Codex selected by default,
the ChatGPT login button and signed-out status. Library/auth directories were
preserved. Real account generation still awaits OAuth; signing remains ad hoc.
