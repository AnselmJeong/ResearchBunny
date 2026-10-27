# ResearchBunny 0.3.17 · 2026-10-27

## Changes

- **Login-only papers come through an app-owned Chrome, not your browser.** PDF 원문 찾기 used to open papers in the Chrome you were using, driven by AppleScript: a tab appeared in your window for every paper and Chrome kept jumping to the front. Live checks showed AppleScript itself un-minimizes the window and steals focus on every page change, and that it reaches whichever Chrome is running (a playwright-mcp Chrome without your logins, for instance). Now:
  - Every paper tries the public route (Unpaywall, publisher PDF addresses) first. Papers with a public copy never open a browser.
  - The rest open in ResearchBunny's own Chrome: the installed Google Chrome with a separate profile in `~/Library/Application Support/ResearchBunny/chrome-profile`, driven over the DevTools pipe. Your Chrome, its profiles, windows and focus are not touched. No Automation permission or "Allow JavaScript from Apple Events" is needed any more.
  - One minimized window per run, one tab for every paper. PDFs are saved straight into the run's staging folder instead of your Downloads.
  - The window comes up only when a person is needed: a robot check that has not cleared by itself within 5 seconds (30 s wait), or a sign-in page (90 s wait). If ResearchBunny is in front it hands focus to that window; otherwise a notification says so. Genealogy reports, which nobody watches, never show it and skip such papers.
  - While ResearchBunny is open after the first use, the Dock shows a second Chrome icon. It quits with ResearchBunny.
- **Log in once.** 자동 원문 찾기 설정 → **전용 Chrome 열기(로그인)** opens a normal window of the app's Chrome with a short guide; log in to your institution's library or proxy and your publishers there. After the first time, **앱 전용 Chrome 사용** is on by default. Institution and proxy logins are usually session cookies that die with the browser, so they are saved encrypted (AES-256-GCM, key created once in your Keychain) on quit, when the login window closes, after each run and every 5 minutes, and restored on the next launch. They are dropped after 7 days. If the institution has ended the session on its side, log in again.
- **PDFs you download yourself are found for every run.** Recovering a PDF you saved by hand into Downloads no longer depends on the Chrome option. The folder setting is now labelled **직접 받은 PDF 폴더**.
- QA builds no longer share the real app's Claude and Codex sign-in folders (or the new Chrome profile): main now hands the service its data folder.

Details and measurements: [아카이브 원문 확보 · 앱 전용 Chrome](fulltext-download.md).

Library schema stays at 3.

## Validation

- Typecheck and lint passed. Integration suite on macOS: **290 passed, 0 failed** across 34 files, including a CDP pipe transport test and a ChromeHost test against a stand-in Chrome on the same protocol (launch flags, prefs kept and enforced, minimized popup-proof work tab, no `Runtime.enable`, download attribution, popups, revealing, encrypted cookie save and restore, a file from another key dropped, handover from a leftover instance of its own profile only), the rewritten retrieval tests, and recovery for runs without the browser and for downloads set aside as another paper's.
- Spike with Chrome 156 in a throwaway profile: no focus change on a windowless launch or on loading pages in a minimized window; two same-site PDFs saved without a prompt; Chrome exits with its parent; a link opened from another app goes to your Chrome, not the app's. Without extra flags pages reported `navigator.webdriver` and minimized timers ran 9.8× slow, hence `--disable-blink-features=AutomationControlled` and three background-throttling flags (1.8×).
- Live run with real Chrome on a scratch library and data folder: two arXiv papers came through the app's Chrome in 11 s and were validated and attached with their PDF addresses; across 32 samples your Chrome stayed in front and the app's Chrome never came forward; a session cookie was stored encrypted and was back after the app's Chrome restarted; no staging folder or Chrome process was left.
- Not checked: the focus handover and notification when a robot check or sign-in page appears in the installed app, and a real institution sign-in.

## Known issue

- A "ResearchBunny quit unexpectedly" dialog was reported on quitting 0.3.7, cause not yet known. Quitting now also saves the app Chrome's sessions and ends it, bounded to 2.5 s.
