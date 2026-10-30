# ResearchBunny 0.3.25 · 2026-10-31

Includes everything in [0.3.24](release-0.3.24.md), which was built but not installed: 답변 (shelf questions answered from passages) and genealogy stages that follow the Settings models.

## Changes

- **Claude answers stopped by Opus safeguards no longer break the reply.** When Opus 5.5's safety classifier stops a message (`stop_reason: refusal`), Claude Code itself rewrites the answer once in the same turn, within the subscription, usually with claude-opus-5. The app used to join the stopped message's text and the rewrite, so a structured reply stopped after some text was no longer JSON. A genealogy report writing with Claude Opus failed this way on the same section every time: `AI 응답을 두 번 받았지만 형식이 맞지 않았습니다: the reply was not valid JSON`.
  - Structured calls now take only the turn's last message: genealogy, and on the Claude connection recommendations, classification, 수신함 정리 and 답변. A rewritten genealogy section says which model rewrote it in its `검사` note, e.g. `claude-opus-5-5의 안전장치가 첫 응답을 멈춰 Claude Code가 claude-opus-5로 다시 썼습니다 (분류: bio).`
  - When the last message is stopped too, the call fails with `Claude의 안전장치가 응답을 멈췄습니다 (분류: …)` instead of a format error, and genealogy does not send the same request again as a format retry.
  - AI 대화 streams text as it comes, so it cannot take text back. If a message is stopped after text was shown, the answer ends with that message instead of a second answer being joined on. If the stop came before any text, only the rewrite is shown.
  - The app still passes no `--fallback-model` and never moves to the paid API.
- **A genealogy section the safeguards still stop is skipped, not fatal.** The section keeps its status and any earlier text, and the reason goes to its `검사` note. The following sections are still written, and the section is not asked again in that run. At the end the write step fails with what was written and what was not: `N절을 쓰고 M절(…)은 쓰지 못했습니다: … 써 둔 절은 그대로 있습니다. 설정 탭에서 집필 모델을 바꾼 뒤 이어서 진행하면 남은 절만 씁니다.` `이어서 진행` writes only the sections still unwritten.
- A JSON reply the parser rejects now gets the parser's message in the corrective retry.

Library schema stays at 3. Written sections live in the library (`genealogy_state`, one `text:<uid>` row per section, plus the outline's section states). Installing this version or reopening the app keeps them. A job that was running when the app quit becomes `중단됨` and continues from where it stopped.

## Validation

- Cause, on the real report: the write stage of `Self-Repair의 계보` (44 sections, write stage Claude `opus`) had written 42 sections and failed twice on 11.3. The library was read read-only. One call was rebuilt from it with the same input and CLI flags. The saved stream showed: a refusal (`bio`) after 864 thinking tokens; `Opus 5.5's safeguards stopped the response above · continuing once`; `model_refusal_fallback` to claude-opus-5; then a valid 8,278-character JSON answer. Replayed through the new client, that stream gives the JSON and the notice. With a partial text message spliced in before the refusal, as in the app's failures, the old client fails with `JSON Parse error: Expected '}'` and the new one returns the same valid JSON.
- `claude.test.ts`: a stopped answer followed by the rewrite (complete returns the rewrite with the notice; stream stops with the reason), a stop before any text (stream shows only the rewrite), and an answer left stopped (fails with the reason and removes request files).
- `genealogy-llm.test.ts`: a stopped answer is `AI_REFUSAL` after one call, and rewrite notices reach the caller.
- `genealogy-write.test.ts`: one of three sections stopped. The other two are written, with one call per section, and the job fails with the message above. `이어서 진행` then writes only that section and leaves the earlier sections' text and rewrite counts unchanged.

## Known issues

- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

## Installation

- Not installed yet.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
