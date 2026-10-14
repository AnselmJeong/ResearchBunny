# ResearchBunny 0.3.5 · 2026-10-14

## Changes

- **Permanent deletion asks what to do with shelf PDFs, and keeps them by default.** Since 0.3.3, `선택 영구 삭제` and `휴지통 비우기` deleted a trashed paper's shelf PDFs from disk with no way to keep them. When the papers have shelf PDFs, the confirmation now lists them under two choices:
  - **`앱에서만 지우기` (default).** The PDFs stay in their folders, and the app stops listing them. They leave the shelf lists, sidebar counts, shelf search, related papers, and 수신함 정리 in every project. A rescan does not bring them back, and they stay hidden when moved or renamed on disk. Nothing on disk is touched, so an offline shelf does not stop the deletion.
  - **`서고 PDF도 삭제`.** This is the 0.3.3 behaviour. The PDFs are deleted from disk in every folder, without going through the macOS Trash. The list turns into a warning, and the button reads `N편과 PDF M개 삭제`. An offline shelf refuses, and a paper whose PDF cannot be deleted stays in the trash.

  The choice resets to `앱에서만 지우기` each time the dialog opens. The service also defaults to keeping PDFs when a caller leaves the option out. The toast reports what happened, e.g. `3편을 영구 삭제했습니다. 서고 PDF 3개는 디스크에 남기고 앱에서만 뺐습니다.`
- **How hiding works.** A hidden PDF keeps its index row with the new status `hidden` and no work, so scans still recognise the file. It is never listed, embedded, proposed for sorting or used as an existing copy. A paper nothing else uses leaves the library, as before. If another project saved the same paper, that project keeps the record and can still open the PDF.
- **Getting a hidden PDF back.** When the app later stores the same bytes again (a download, an import, or moving app-folder PDFs to the shelf), it shows the hidden file again as that paper's PDF instead of writing a second copy. Deleting such a paper later with `서고 PDF도 삭제` also reaches the hidden PDFs it still links to.
- Settings → `서고` counts hidden files as `앱에서 뺌` in the index status.

Library schema stays at 3. Hidden files use a new status value in `shelf_files`, so no table changes. An older app reading this library would list them again, because it does not know the status.

## Validation

- Typecheck and lint passed. Integration suite: **201 passed, zero failed** across 22 files.
- New shelf test. It fails without the change, because the default deletion removes the files.
  - Deleting with no option, while the shelf is unmounted, hides the 3 PDFs (an inbox paper and a paper with a copy in another folder). The files on disk do not change.
  - After a rescan, neither paper shows in any project's shelf list, inbox, sidebar counts, shelf search or 수신함 정리 count. The status counts read 3 hidden.
  - The paper nothing else uses is gone. The one another project saved keeps its record, and its PDF still opens.
  - A hidden PDF moved to another folder stays hidden, and that project's link follows it.
  - Depositing the same bytes again shows the hidden inbox file as the new paper's PDF, and writes no second file.
  - Deleting the other project's paper with `서고 PDF도 삭제` deletes the hidden PDF and its hidden copy.
- The 0.3.3 deletion test now passes `pdfs: "delete"` explicitly and still checks every case it did.
- The real renderer was run against a scratch library with a synthetic 4-PDF shelf, in light and dark themes.
  - `휴지통 비우기` opened on `앱에서만 지우기` with the 3 PDFs listed as staying on disk.
  - Switching to `서고 PDF도 삭제` turned the list into a warning and the button into `3편과 PDF 3개 삭제`.
  - Confirming the default left all 4 PDFs on disk, marked 3 rows hidden, and showed `앱에서 뺌 3` in Settings.
  - A later `서고 PDF도 삭제` on one paper deleted only that PDF.
