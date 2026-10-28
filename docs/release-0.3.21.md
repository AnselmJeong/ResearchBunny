# ResearchBunny 0.3.21 · 2026-10-28

## Changes

- **미분류 papers can be filed by hand.** Once the AI judges a paper uncategorized, sorting again keeps it there: the input is the same and the prompt never forces a leaf. The 미분류 list now has `폴더로 보내기…` on the selection bar and a folder button on each row. It opens a list of the taxonomy's domains and leaves, filterable by name and definition, and moves the papers into the chosen leaf with no AI decision. A leaf in `taxonomy.json` whose folder is gone from disk is shown as `서고에 없음` and cannot be chosen.
- **A new folder can be made at that moment.** `새 폴더 만들기` takes an existing domain, a name and an optional one-line definition. `AI 초안` drafts the definition from up to 12 of the papers' titles and abstracts and the domain's other leaf definitions; no file paths are sent and the AI never names the folder. Names with `/` or `\`, a leading `.` or `_`, characters an SMB share refuses (`: * ? " < > |`), a trailing `.`, or a name already in the domain (ignoring case and Unicode normalisation) are refused, on screen and in the service, before indexing stops. New top-level domains are not offered; they are still made by editing `taxonomy.json`.
- **The sort window offers `새 폴더…` too.** Picking it in a row's folder list opens the same fields under that row. The folder is made when the papers going there are moved, and becomes an ordinary leaf for the rest of the proposal.
- **taxonomy.json keeps its lines.** A new leaf is the entry `intake.py addleaf` writes (`{name, def, incl: [], excl: [], ex: []}`). In a file kept one leaf per line, like the real shelf's, it becomes one line after the domain's last leaf, in that line's indent and spacing; the only other change is the comma that line gains, and the domains keep their order. Any other layout is rewritten exactly as `addleaf` would (the domain's leaves sorted by name, `indent=1`, non-ASCII kept). Either way the file is replaced atomically. Without `taxonomy.json` the folder alone is made. The day's `logs/intake-*.md` gets an `## addleaf … · ResearchBunny` block before the usual `## run` block.
- **A folder renamed by hand is never recreated.** Every move now takes one path. A taxonomy leaf missing on disk used to be recreated with `mkdir`, which brought back a folder the user had renamed under its old name. Such moves are now skipped with `폴더가 서고에 없습니다. 손으로 이름을 바꿨거나 지웠다면 _system/taxonomy.json도 고치세요.` A missing domain folder refuses a new leaf in it. `_uncategorized` and `_duplicated` are still made when missing.
- Moves by hand go through the same checks and ledger as 수신함 정리: size check, ` (2)` names, `move_log.jsonl`, the intake log and `index.json`, with works, embeddings, attachments and passages following the files without rehashing. Only papers in `_uncategorized` move from the 미분류 list; others are skipped as `미분류에 없는 논문입니다.`, and no folder is made when nothing can move.

Library schema stays at 3.

## Validation

- Typecheck and lint passed. Integration suite on macOS, after merging 0.3.20: **300 passed, 0 failed** across 35 files. `shelf-sort.test.ts` gained four tests on scratch shelves:
  - filing into an existing leaf and into a new leaf, with the index, attachment paths, move log, intake log and `index.json` following;
  - refused names and domains leaving disk and `taxonomy.json` untouched;
  - papers outside 미분류 and non-leaf targets refused;
  - a hand-made folder adopted, and a case-only clash refused;
  - a renamed leaf or domain not recreated, from both paths, and the sort window's `create` making a leaf in the same call;
  - folders mode with no `_system`;
  - the definition draft payload;
  - a one-leaf-per-line `taxonomy.json` matched character for character after leaves were added to two domains, with `": "` spacing kept;
  - other layouts byte-identical to running the real `cmd_addleaf` code in Python.
- A scratch copy of the real `taxonomy.json` (108 lines) with two leaves added differed only by the two commas and the two new lines, and Python read every other value back unchanged.
- Browser harness (`.qa/file-into/`: the real service over HTTP on a scratch library and a synthetic shelf with `taxonomy.json`, the real renderer through Vite, fake Ollama and a keyword AI). Checked:
  - the selection-bar and row actions, the leaf list and its filter;
  - a refused name disabling the buttons;
  - the AI draft;
  - two papers filed into a new leaf, confirmed on disk;
  - a leaf renamed on disk shown as `서고에 없음`;
  - `새 폴더…` in the sort window, defaulting to the row's candidate domain and made on apply;
  - light and dark themes.
- Packaged app: the DMG's checksum is valid and strict signature verification passed for the bundle inside the `.tar.zst` (0.3.21). The packaged smoke test passed on the extracted bundle with a restricted PATH (PDF reader chunks, threads, extraction, folder matching, archive, BibTeX and PDF folder export, backup, restore and permanent deletion). The packaged service contains `shelfFileInto`, and the renderer contains `폴더로 보내기`.
- Not checked: the real shelf, the real AI and the installed app's own window.

## Known issues

- When 미분류 is emptied, its sidebar entry disappears and the open list's title falls back to `서고 0편`. This predates 0.3.21 but now happens more often.
- `intake.py leaves` numbers leaves across all domains, so a new leaf shifts the numbers of every leaf after it. Look at `leaves` again before classifying with intake.py after making a folder in the app.
- The first passage search after launch takes about 2.5 s while the in-memory sign bits load, and the service does not answer other requests during that time.
- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known.

## Installation

- Backed up the previous app and a consistent SQLite snapshot under `~/Library/Application Support/ResearchBunny/app-backups/20261028-222216-file-into-0.3.21` (integrity ok, schema 3, **12,361 works**, **9,203 attachments**, **9,238 shelf files**, 6 projects, matching the live library). The replaced 0.3.20 bundle is kept there as `ResearchBunny-0.3.20-installed.app` (signature verified). `passages.sqlite` was not copied: 0.3.21 does not change it, and the 0.3.18 backup holds a clone.
- Replaced `/Applications/ResearchBunny.app` with version **0.3.21** (bundle hash `1my7xp1076ido`); all **242 files** match the package and strict signature verification passed. The app was not running and was not launched.
- The real shelf's `_system/taxonomy.json` is unchanged until a folder is first made in the app.

Artifacts, built from `a174017`: `out/electrobun/stable-macos-arm64-ResearchBunny.dmg` (SHA-256 `110d95f9…1372283e3`) and `out/electrobun/stable-macos-arm64-ResearchBunny.app.tar.zst` (`2a9b509b…1042b6434`), also copied to the main checkout's `out/electrobun`. Local validation logs are under `.qa/release-0.3.21/`.

Local ad-hoc signing on macOS Apple Silicon; no Developer ID signing or Apple notarization.
