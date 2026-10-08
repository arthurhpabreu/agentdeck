# Validation evidence

## 0.6.3

Validated locally on Windows on October 8, 2026.

| Check | Result |
| --- | --- |
| TypeScript and production build | Passed; optimized Windows executable generated. Existing Vite chunk-size and mixed-import warnings remain. |
| Translations and Rust formatting | Passed: 405 EN/PT/ES keys and `cargo fmt --check`. |
| Playwright browser suite | 105 passed. Composer geometry checks cover idle/compacting states at 1000, 1280 and 1600 px window widths. |
| Rust library suite | 136 passed, 6 optional tests ignored, no failures. |
| Packaged memory MCP smoke test | 11 scenarios passed with 33 RPC requests against the 0.6.3 executable and isolated temporary storage; no model requests. |
| Windows installers | x64 NSIS/MSI generated; version 0.6.3, publisher, containers, bundled license and unchanged MSI upgrade code verified. |
| Release integrity | SHA-256 manifest includes both installers and LICENSE. Generated artifacts remain outside source control. |

The composer regression verifies stable selector coordinates during compaction,
aligned attachment/context/response actions, no action overlap or horizontal
overflow, and an on-screen context settings panel. Composer screenshots at each
width were inspected locally. Existing compaction, archive, session naming and
application update coverage also passes. Browser tests mock native boundaries;
these checks do not establish an interactive clean-machine upgrade or live paid
provider execution. Installers remain unsigned. GitHub CI validates the release
branch independently before publication.

## 0.6.2

Validated locally on Windows on October 8, 2026.

| Check | Result |
| --- | --- |
| Frozen pnpm installation and repository hygiene | Passed with committed lockfiles; 312 project files checked before this evidence update. |
| TypeScript and production build | Passed; optimized Windows executable generated. Existing Vite chunk-size and mixed-import warnings remain. |
| Translations and Rust formatting | Passed: 405 EN/PT/ES keys and `cargo fmt --check`. |
| Playwright browser suite | 104 passed, including 11 context/history scenarios. |
| Rust library suite | 136 passed, 6 optional tests ignored, no failures. |
| Packaged memory MCP smoke test | 11 scenarios passed with 33 RPC requests against the 0.6.2 release executable and isolated temporary storage; no model requests. |
| Windows installers | x64 NSIS/MSI generated; package version 0.6.2, publisher, containers, bundled license and unchanged MSI upgrade code verified. |
| Release integrity | SHA-256 manifest includes both installers and LICENSE. Generated artifacts remain outside source control. |

Compaction coverage exercises both providers, prompt and context-token thresholds,
explicit opt-out, independence from lifetime usage, settings persistence, failed
or unconfirmed compaction, fresh threads, queued supplementary input, cancellation,
late events, session identity and native sequencing before the actual request.
Native protocol fixtures require confirmed completion rather than treating an RPC
acknowledgment or an unconfirmed Claude success result as successful compaction.

History coverage archives 1,500 messages, verifies an 80-message rendered page,
searches the first archived message, exports every message and reloads the archive.
It also exercises 400 unsaved messages during a transaction failure, a 500-message
legacy migration after storage cannot open at startup, 1,000 reasoning notifications
and a 400-delta stream burst. Eviction follows a successful write; failed migration
retains all pending records for retry.

Browser tests mock native boundaries; Rust tests use protocol fixtures. These
checks do not establish successful live paid provider compaction, reproduce every
possible provider or WebView crash, or prove an interactive clean-machine upgrade.
The active turn stays resident for stream correctness. Installers remain unsigned.
GitHub CI validates the release branch independently before publication.

## 0.6.1

Validated locally on Windows on October 8, 2026.

| Check | Result |
| --- | --- |
| Frozen pnpm installation | Passed with the committed dependency lockfile. |
| TypeScript and production build | Passed. Existing chunk-size and mixed-import warnings remain. |
| Translations and Rust formatting | Passed: 405 EN/PT/ES keys and `cargo fmt --check`. |
| Playwright browser suite | 93 passed, including four session naming and four application update scenarios. |
| Rust library suite | 129 passed, 6 optional tests ignored, no failures. Final installer-type selection also passed the focused updater suite. |
| Official release download smoke test | Explicit opt-in test passed separately: both published 0.6.0 installers downloaded and verified against their containers and release SHA-256. No installer was opened. |
| Packaged memory MCP smoke test | 11 scenarios passed with 33 RPC requests against the release executable and an isolated temporary database; no provider/model requests. |
| Windows installers | Optimized x64 NSIS/MSI bundles generated; package versions, MSI publisher and unchanged upgrade code checked. |
| Release integrity | SHA-256 manifest includes both installers and LICENSE. Generated artifacts stay outside source control. |

Session naming coverage includes keyboard activation within sortable rows,
blank-name rejection, Escape cancellation and focus restoration, persistence,
recovery, renaming during active chat, first-message naming, and native startup.
Older sessions keep their existing automatic naming until explicitly renamed.

Application update coverage includes one startup check, numeric version ordering,
stable-release filtering, exact official assets, both installer types, bounded
downloads, checksum/container failures, retry, explicit installation and busy
agent/terminal gating. Tauri's embedded bundle type selects the package format.
Native commands do not accept caller-provided download URLs or executable paths.

Memory regressions exercise prompts above 8,000 bytes with accents and emojis,
project notes, a global Obsidian vault, the configured context budget and delivery
deduplication. The provider prompt is retained in full; automatic retrieval uses
only bounded opening/ending samples. Explicit search limits are preserved.

Browser tests use mocked native boundaries. These checks do not establish a
successful interactive in-place upgrade on a clean machine or live provider
execution. Installers remain unsigned; macOS/Linux updating is not supported by
the new application updater. GitHub CI runs independently of these local checks.

## 0.6.0

Validated locally on Windows on October 7, 2026.

| Check | Result |
| --- | --- |
| Frozen pnpm installation, translations and Rust formatting | Passed. Translation checker covers 402 EN/PT/ES keys. |
| TypeScript and production build | Passed. |
| Playwright browser suite | 85 passed, including all nine command/skill scenarios. |
| Rust library suite | 123 passed, 5 optional tests ignored, no failures. |
| Installed CLI metadata probes | Explicit opt-in test passed: Claude returned 46 command entries and Codex returned 5 skills, without model prompts. |
| Windows installers | Optimized x64 build and NSIS/MSI bundles completed. Both report 0.6.0; MSI publisher is Arthur Abreu. |
| License packaging | Current LICENSE matches the release resource and is present in the MSI file table. |
| Artifact integrity | PE/OLE containers checked; SHA-256 checksums generated for both installers and LICENSE. |

Command coverage includes namespaced invocations with arguments, local session
controls without model turns, unknown command rejection, mid-prompt Codex skills,
additional input while busy, session-preserving terminal handoff, Claude supported
commands, metadata refresh, Gemini startup/follow-up inputs, Escape, and a narrow
light window. Native skill inputs are tested separately from frontend paths.

These checks do not establish successful installation on a clean machine or a live
paid skill execution. Installers remain unsigned. GitHub CI is independent of
these local results. The draft-release workflow now preserves published assets
and can update an existing draft; its revised upload path has not been rerun.

## 0.5.0

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

The Windows CI workflow passed for the final 0.5.0 documentation commit. The original draft-release job reached packaging but failed because a manually published release already had assets with the same names; that duplicate upload path is addressed in 0.6.0. NSIS/MSI installers were generated locally and remain unsigned. Installing them on a clean machine has not been tested. macOS and Linux behavior has not been validated.

Vite reports existing warnings about large output chunks and mixed static/dynamic imports of Tauri core. These do not prevent the production build; bundle splitting remains a separate performance improvement.
