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
