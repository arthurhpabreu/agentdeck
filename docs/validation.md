# Validation evidence

Agent Deck 0.5.0 was validated locally on Windows on October 7, 2026, using Node.js 24.15.0, pnpm 9.15.4 and the stable Rust toolchain.

| Check | Result |
| --- | --- |
| Frozen dependency installation | Passed with the committed pnpm lockfile. |
| TypeScript and production Vite build | Passed. |
| Translation consistency | Passed: 402 keys across English, Portuguese and Spanish. |
| Playwright browser suite | 76 passed. Native commands use synthetic fixtures. |
| Rust library suite | 118 passed, 4 ignored, no failures. |
| Rust formatting | `cargo fmt --check` passed. |
| Repository hygiene | Tracked source, required build inputs, version consistency and sensitive-file checks passed. |
| Windows release build | Optimized native build and NSIS/MSI bundles completed successfully. |
| Installer verification | Executable and MSI metadata report 0.5.0; container checks and SHA-256 hashes passed. |

## Graph and agent coverage

- A synthetic 1,600-note vault exercises folder aggregation, full-index selection, bounded note rendering, one- and two-hop neighborhoods, zoom and keyboard/focus behavior.
- A native graph regression verifies that notes and edges beyond the former 120-note display limit remain indexed, including isolated notes.
- Agent map tests cover selection shared with the task board and inspector, provider/session filters, pan/zoom, centering, animation controls and reduced motion.
- A 38-agent fixture covers two sessions, 36 subagents, missing parents, cyclic relationships and a narrow light-theme viewport.
- CLI indicator tests cover confirmed updates, badge counts after updating and hiding the badge when version checks fail.

The [agent map](images/agent-flow-map.png) and [knowledge graph](images/knowledge-expanded.png) screenshots contain synthetic data. They are documentation assets rather than captures of a personal project or provider account.

## Scope and remaining validation

Browser tests verify the UI against mocked desktop commands. They do not authenticate providers, send prompts or establish live agent collaboration. Four optional native tests that require installed clients or account integrations were ignored; live provider checks were not rerun for this change. Recorded subagent states remain distinguishable from live session activity in the interface.

The Windows CI workflow has started on GitHub; its result is separate from the local checks above. The tag-triggered draft-release workflow is configured but has not been validated. NSIS/MSI installers were generated locally and remain unsigned. Installing them on a clean machine has not been tested. macOS and Linux behavior has not been validated.

Vite reports existing warnings about large output chunks and mixed static/dynamic imports of Tauri core. These do not prevent the production build; bundle splitting remains a separate performance improvement.
