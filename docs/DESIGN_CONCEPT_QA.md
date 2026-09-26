# ResearchBunny 0.1.2 — design concepts v1 implementation QA

Reference: [five-screen concept gallery](design-concepts/2026-09-26-v1/gallery.html).

Implemented in the Electron renderer:

- Warm ivory/white and charcoal themes, botanical green actions, larger utility text, editorial paper rows and a compact discovery search header.
- A single discovery popover for related papers, references and cited-by, with common-relation controls retained. Native dismissal and existing contextual help remain available.
- Abstract/evidence/notes inspector tabs with keyboard navigation; notes, attachments, metadata editing and duplicate management remain accessible.
- Archive reading-state columns and filters. Filtering happens before counts and pagination, and is persisted with the existing navigation view. New discovery runs do not inherit a library-only reading filter.
- Full-page exploration history grouped by persisted `parentId`, with sibling branches, actual source-paper details and stage restoration. Older runs without parents remain separate roots.
- Full-page settings with grouped connections, optional AI, local library, appearance and collapsed advanced controls. API keys remain masked; registered keys are not presented as verified connections.
- Graph labels focus on eight structurally prominent papers plus inspected/selected nodes. Citation direction and node identity are unchanged; graph theme follows the user's appearance preference.

Validation uses isolated temporary libraries and deterministic provider-cache fixtures, not the user's library. Screenshot paper titles are test fixtures.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npm test` | 19 passed |
| `npm run test:desktop` | Passed: manual entry, note autosave, BibTeX, PDF, graph/year view, restart, backup/restore and utility-process recovery |
| `npm run test:navigation` | Passed: selection/filter restoration, sibling exploration, restart, project isolation and tooltip behavior |
| `npm run test:design` | Passed: history hierarchy/source details, archive reading filters, note tab persistence, full settings page, saved theme and 980px layout |
| `git diff --check` | Passed |

Actual development-app captures are generated under `artifacts/qa/` (gitignored):

- `design-discovery.png`
- `design-graph.png`
- `design-archive.png`
- `design-history.png`
- `design-settings.png`
- `design-compact.png`

Run `npm run build` before desktop checks. Reports are `desktop-report.json`, `navigation-report.json` and `design-report.json` in the same directory. This verifies the development Electron app; installed applications and DMGs are separate artifacts.
