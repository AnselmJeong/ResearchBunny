# ResearchBunny 0.3.3 · 2026-10-12

## Changes

- `수신함 정리` no longer reopens on the last run's record. A proposal stays saved after its PDFs are moved, so reopening the dialog showed `152편을 옮겼습니다.`, `제안 다시 만들기` and `✓ 수신함에 정리할 PDF가 없습니다.` even with 90 new PDFs in the inbox. That empty-inbox line came from the old proposal, not from the inbox.
- The dialog now counts today's inbox (root and `_uncategorized`) each time it opens. With nothing left in the saved proposal, it shows `수신함에 PDF N편이 있습니다.` and `제안 만들기`; `✓ 수신함에 정리할 PDF가 없습니다.` appears only when the index has no inbox PDFs.
- When a proposal still has items and PDFs arrived after it was made, the dialog says how many are not in it and that `제안 다시 만들기` will include them. PDFs this proposal moved into `_uncategorized` are not counted as new.
- Moving the last items of a proposal clears it. Moving only some of them leaves `남은 제안 N편 · 옮길 논문 M편` instead of the move count. The move count and the ledger note stay in the dialog where the move happened.

Library schema stays at 3. A proposal saved by 0.3.1 or 0.3.2 is read as before; when its items are used up, its old message is ignored.

## Validation

- Typecheck and lint passed. Integration suite: **192 passed, zero failed** across 21 files.
- The inbox-sort test now also checks the following after the first move. Without the fix it fails, because the sorter has no inbox count.
  - The remaining proposal reads `남은 제안 1편 · 옮길 논문 1편` with 3 inbox PDFs and none new.
  - A PDF added afterwards counts as 1 new.
  - Moving the last item clears the proposal.
  - A 0.3.2-style saved state (`152편을 옮겼습니다.`, no items) reports every inbox PDF as new.
- The dialog was rendered with stubbed states in the dark theme: a used-up 0.3.2 proposal with 90 inbox PDFs, an open proposal with 90 newer PDFs, and an empty inbox.
