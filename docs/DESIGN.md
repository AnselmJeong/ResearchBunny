# ResearchBunny implementation decisions

The implementation boundary is PRD.md P0 and IMPLEMENTATION_PLAN.md stages 0–7. P1–P3 are deferred.

Visual thesis: a quiet research desk, with warm white surfaces, graphite typography and a single forest-green accent.

Content plan: project navigation at left, search and the working collection in the center, a contextual paper inspector at right. The empty workspace offers search, local import and optional AI discovery. There is no marketing dashboard or fabricated library.

Interaction thesis: short panel reveals, immediate shared selection between list and graph, and restrained progress transitions; reduced-motion preferences disable animation.

Technical decisions:

- Electron, React, TypeScript, Vite; Forge packages prebuilt Vite/esbuild outputs. This avoids coupling utility-process builds to the experimental Forge Vite plugin.
- A single utility process owns SQLite and background jobs. PDF extraction runs in a bounded worker thread.
- Native macOS arm64 build; local trial distribution uses ad-hoc signing. Developer ID notarization requires distribution credentials.
- OS-protected encrypted API key file is separate from the library and all backups. Renderer only receives configured/not-configured status.
- OpenAlex requests use Authorization headers, cursor paging and fixed host URLs. No credentials in query strings.
- Candidate inspection, screen selection, anchor seeds and archived works are distinct states.
- Recommendation weights are a versioned provisional baseline, not calibrated probabilities. GPT remains experimental until human evaluation satisfies PRD 9.3.
- Data defaults to Electron userData/library. Managed PDF copies are content addressed. Restore opens a verified separate library and retains the previous one.

Navigation and help (0.1.1):

- Project-local history retains each visited screen's latest selection, filters, sort, view, graph positions, pagination and inspector state. Back/forward changes the screen; library undo changes saved data.
- Exploration breadcrumbs follow persisted run parents. A fresh keyword/AI search starts a new root; branching retains previous runs. An old parent without a cached view defaults to the child run's input selection.
- Preferences retain up to 40 screen snapshots and 60 visits, trimmed below 850 KB where possible. Eviction does not delete runs or papers.
- Descriptive help is delegated across controls, appears after a short hover or on focus, and uses a native popover to remain above dialogs. Escape dismisses it; the target receives aria-describedby while visible.

## Design concepts v1 implementation (2026-09-26)

Reference: `design-concepts/2026-09-26-v1/` (all five screens).
Visual thesis: warm ivory and white surfaces, charcoal text, botanical green selection, readable editorial paper rows.
Content plan: compact discovery search, project navigation, paper workspace and tabbed inspector; dedicated history and settings workspaces.
Interaction thesis: a single discovery menu with keyboard/outside dismissal, quiet row/selection transitions, and tab changes without losing note drafts.
Implementation boundary: preserve existing search, graph direction, navigation snapshots, imports, backups and local storage. History branches use persisted parentId, never chronological inference. Example papers/counts in the concepts are not application data. Themes remain a user preference rather than switching automatically for graphs.
Validation: typecheck, lint, build, integration and desktop flows with isolated fixture data, plus screenshots of the five workspaces.
