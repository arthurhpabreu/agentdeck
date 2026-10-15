# Validation evidence

## 0.9.1

Published October 15, 2026. All tagged Windows x64, macOS Apple Silicon and macOS Intel validation jobs passed. Four installers/application packages, LICENSE and the aggregate checksum manifest were downloaded and verified before publication; the same universal Mac application passed native execution and visual inspection on both architectures. See the [release validation](validation/0.9.1-release.md) for source, test counts, checksums and limits.

## 0.7.0

Validated on October 14, 2026 with native Windows x64, macOS Apple Silicon and macOS Intel jobs in the [cross-platform preview](https://github.com/arthurhpabreu/agentdeck/actions/runs/38603037958).

| Check | Result |
| --- | --- |
| Frontend, translations, repository/version checks and Rust formatting | Passed on all three native runners; 475 EN/PT/ES translation keys. The four application manifests agree on 0.7.0. Existing Vite chunk-size and mixed-import warnings remain. |
| Native Rust library suite | 211 passed, zero failures and six optional tests ignored on each platform. |
| Windows Chromium interface suite | All 170 scenarios passed, including chat continuity, context controls, updater, terminal, navigation and authentication notice regressions. |
| macOS WebKit interface smoke | All nine tagged scenarios passed on both Apple Silicon and Intel. Covers native platform precedence, login shells, Command shortcuts, clipboard Unicode/Ctrl+C, Mac controls, localized DMG updates, POSIX resume and missing `randomUUID`. |
| Authentication notice lifecycle | Focused Chromium and WebKit checks passed: eight-second expiry, manual dismissal, duplicate suppression, new real errors, fatal-error retention and legacy localStorage/IndexedDB restoration without stale notices. |
| Native Unix callbacks | Both Macs passed real socket Unicode delivery, fast sender disconnection, incomplete-peer deadlines, bounded reads and partial-write/backpressure tests. No ignored socket tests. |
| Custom shell discovery | Both Macs passed literal fish argument and POSIX path tests, including spaces, apostrophes and shell metacharacters. |
| Window placement | Eight native regression cases passed, including small displays, restored bounds, Retina, removed monitors and unavailable geometry. The public AppKit/Core Graphics inspection also passed in the [native diagnostic](https://github.com/arthurhpabreu/agentdeck/actions/runs/38602845720). |
| Universal Mac bundle | The same packaged application passed native checks on Apple Silicon and Intel: bundle identifier/version, arm64+x86_64 slices, macOS 11.0 deployment target in both Mach-O slices, unchanged bundled LICENSE, strict code-signature validation and DMG verification. The signature is ad-hoc and the package is not notarized. |
| Packaged Mac execution | Both machines ran the actual GUI for 20 seconds with a Finder/Dock reopen event, no fatal startup logs or crash reports. Native window geometry stayed within the menu/Dock work area; both desktop captures were visually inspected. Apple Silicon used a 1024×768 display and Intel used 1920×1080. |
| Packaged native helpers | Both architectures passed Claude statusline/quota parsing, private-field sanitization, owner-only cache permissions and Unicode delivery through the Codex and Claude Unix-socket hook bridges. These checks use the real bundled executable with isolated fixtures. |
| Windows installers | Both generated x64 installers passed read-only container and metadata checks: version 0.7.0, publisher, bundled application/license and unchanged MSI upgrade identity. No installer was executed. |
| Preview package integrity | All four downloaded packages and LICENSE passed the staged SHA-256 manifest check. macOS archive gzip and DMG UDIF footer checks passed. The tagged release workflow creates its own aggregate manifest for the final packages. |

Browser tests mock native commands, while the Rust suite exercises native process and socket fixtures. They do not authenticate provider accounts or send model requests. Native CI uses macOS 15; the deployment target is macOS 11.0 with a documented Safari/WebKit 16.4+ requirement. These checks do not establish operation on an unpatched Big Sur installation or an interactive clean-machine upgrade.

## 0.6.8

Validated locally on Windows on October 14, 2026.

| Check | Result |
| --- | --- |
| TypeScript and production frontend build | Passed for version 0.6.8. Existing Vite chunk-size and mixed-import warnings remain. |
| Translations and Rust formatting | Passed: 471 EN/PT/ES keys and `cargo fmt --check`. |
| Rust library suite | 195 passed, 6 optional tests ignored, no failures; 55 cover chat protocol and recovery. |
| Playwright browser coverage | 160 scenarios covered across the full run and focused checks. The initial full run passed 157 of 159; a memory scenario passed independently after a development-server reload, and a large-history timeout exposed excessive text layout. The corrected large-history scenario and the added pagination scenario passed with all content assertions preserved. |
| Large continuation archive | More than 13 MiB of UTF-8 history reconstructed exactly from bounded byte parts. The final focused run completed the archive scenario in 6.8 seconds and verified that rendered history remains bounded. |
| History navigation | Large-message pages preserve every archived message. Previous-page checks reached entries 59, 58 and 57 in order; returning to latest and searching an older entry also passed. |
| Packaged memory MCP smoke test | 12 scenarios passed against the optimized 0.6.8 executable: 36 RPC requests, 3 processes, no stderr or unexpected responses. |
| Packaged Codex RTK smoke test | Five checks passed against the packaged adapter and installed RTK. No model requests. |
| Windows installers | NSIS and MSI x64 packages generated. Version 0.6.8, publisher, bundled LICENSE, application architecture and unchanged MSI upgrade identity verified without installation. |
| Release integrity | SHA-256 manifest covers both installers and LICENSE; staged copies match the generated artifacts and repository license. |

Chat regressions cover both providers, measured context windows, conversation
goals and attachment paths, post-compaction pressure, retained summary readings,
subagent isolation, archived history, storage failures, separate provider IDs,
unsent continuation drafts and oversized input during an active response. Native
tests cover retry versus fatal errors, protocol deadlines, unconfirmed input,
MCP warnings and confirmed-completion transport cleanup.

Browser tests use mocked desktop commands and native chat tests use protocol
fixtures. Packaged smoke checks use isolated temporary databases and commands.
They do not authenticate external integrations, send model requests or establish
live provider behavior. A clean-machine install/upgrade was not exercised.
Installers remain unsigned.

## 0.6.7

Validated locally on Windows on October 9, 2026.

| Check | Result |
| --- | --- |
| TypeScript and production frontend build | Passed for the Telegram implementation and again with version 0.6.7 during packaging. Existing Vite chunk-size and mixed-import warnings remain. |
| Translations and Rust formatting | Passed: 471 EN/PT/ES keys and `cargo fmt --check`. |
| Playwright browser coverage | 144 scenarios covered across the full run and a focused rerun. The full run passed 143; an existing history scenario timed out and then passed independently. All four Telegram scenarios passed. |
| Rust library suite | 183 passed, 6 optional tests ignored, no failures. |
| Independent implementation CI | The Windows workflow passed for feature commit `d5ab238`: [GitHub Actions run](https://github.com/arthurhpabreu/agentdeck/actions/runs/37989008766). |
| Repository hygiene | Passed for 350 tracked project files; required inputs and application versions verified. |
| Packaged memory MCP smoke test | 12 scenarios passed against the optimized 0.6.7 executable: 36 RPC requests, 3 processes, no stderr or unexpected responses. |
| Packaged Codex RTK smoke test | Five checks passed against the actual adapter and installed RTK: canonical hook contract, preserved arguments, double-prefix protection, unrelated-event rejection and isolated command measurements. No model requests. |
| Windows installers | Both Windows x64 packages generated. Application and NSIS/MSI signatures, version 0.6.7, publisher, bundled LICENSE and unchanged MSI upgrade identity verified without installation. |
| Release integrity | SHA-256 manifest covers both installers and LICENSE; staged copies match the generated artifacts and repository license. |

Telegram browser coverage exercises private pairing, token masking, explicit test
sends, the main notification switch, disconnect, pairing retries and credential
cleanup failures. Native tests cover exact recent pairing codes in private human
chats, expiry, token validation, token-free configuration, disconnect recovery,
encoded API requests, bounded responses and redacted transport/server errors.
The existing completion tests cover successful main responses, duplicate events,
queued input, child events, compaction and interruptions.

Browser tests mock native commands and native Telegram API tests use a local
HTTP fixture. No real Telegram bot or Android/iPhone delivery was exercised.
These results do not establish real phone delivery or an interactive
clean-machine upgrade. Installers remain unsigned.

## 0.6.6

Validated locally on Windows on October 8, 2026.

| Check | Result |
| --- | --- |
| TypeScript and production build | Passed; optimized 0.6.6 executable and both Windows installers generated. Existing Vite chunk-size and mixed-import warnings remain. |
| Translations, formatting and repository hygiene | Passed: 422 EN/PT/ES keys, `cargo fmt --check` and 346 tracked project files. |
| Playwright browser coverage | 140 scenarios covered across the full run and focused reruns. The full run passed 139; one heartbeat fixture still used the old silence threshold. After correction, both silence/heartbeat scenarios passed. The four economy scenarios also passed after the final RTK changes. |
| Rust library suite | 174 passed, 6 optional tests ignored, no failures. |
| Packaged memory MCP smoke test | 12 scenarios passed against the final executable: 36 RPC requests, 3 processes, no stderr or unexpected responses. |
| Packaged Codex RTK smoke test | Five checks passed against the real adapter and RTK 0.39.0: canonical hook contract, preserved arguments, double-prefix protection, unrelated-event rejection and isolated command measurements. |
| Optional installed RTK test | Passed separately with an isolated database and project-separated measurements. |
| Read-only vault check | A previously partial local vault returned no partial-index or unavailable warning with the final executable. No note excerpts were returned, and Markdown file sizes and modification times were unchanged. |
| Windows installers | x64 payload, NSIS/MSI containers, version 0.6.6, publisher, bundled license resource and unchanged MSI upgrade identity verified. SHA-256 manifest covers both installers and LICENSE. |

Regression coverage includes closed tool cards, manual and keyboard expansion,
preserved expansion during stream updates, the two-minute inactivity boundary,
matching Documents/Shared Memory controls in both themes, editable custom project
colors, invalid hex input, cancellation and persistence. Native tests cover
successful versus interrupted turns, queued input, child events, compaction and
duplicate completion notifications. Vault fixtures exercise half-mebibyte notes,
truncation above 1 MiB, the total byte cap, exact and exceeded note limits, deep
folders and unreadable Windows files with recovery.

The Codex hook metadata probe used installed Codex 0.162.0 without model requests
and confirmed native trust remains a separate requirement. The RTK smoke test
does not claim that a live model invoked a trusted hook. Browser tests mock native
commands; no paid model turns, real desktop notification delivery or interactive
clean-machine upgrades were exercised. Installers remain unsigned. GitHub Actions
validates the release commit independently.

## 0.6.5

Validated locally on Windows on October 8, 2026.

| Check | Result |
| --- | --- |
| TypeScript and production build | Passed; optimized 0.6.5 executable and both Windows installers generated. Existing Vite chunk-size and mixed-import warnings remain. |
| Translations and Rust formatting | Passed: 405 EN/PT/ES keys and `cargo fmt --check`. |
| Playwright browser suite | 136 passed with a fresh isolated development server. |
| Rust library suite | 159 passed, 6 optional tests ignored, no failures. |
| Packaged memory MCP smoke test | 12 scenarios passed against the optimized 0.6.5 executable: 36 RPC requests, 3 processes, no stderr or unexpected responses, and no model requests. |
| Windows installers | x64 payload, NSIS/MSI containers, version 0.6.5, publisher, bundled license resource and unchanged MSI upgrade identity verified. |
| Release integrity | SHA-256 manifest covers both installers and LICENSE. Generated artifacts remain outside source control. |

Regression coverage includes terminal output, long active-turn history, late tool
updates, missed completion recovery, composer alignment, unsaved editor buffers,
memory drafts, export destinations and prepared/delivered context sources. Vault
fixtures exercise unavailable folders, partial indexes, encoded Markdown links,
fences and reads outside the selected source. Git fixtures verify that worktree
cleanup preserves ignored files, active processes and detached commits, rechecks
the inspected commit, and finds folders created from repository subdirectories.

The packaged memory test confirms that an unavailable vault produces a warning
while saved memories remain searchable, and that restoring the source clears the
warning without restarting. Browser tests mock native commands; no live paid
provider execution or interactive clean-machine upgrade is claimed. Installers
remain unsigned. GitHub Actions provides independent validation of the release
commit.

## 0.6.4

Validated locally on Windows on October 8, 2026.

| Check | Result |
| --- | --- |
| TypeScript and production build | Passed; optimized Windows executable generated. Existing Vite chunk-size and mixed-import warnings remain. |
| Translations and Rust formatting | Passed: 405 EN/PT/ES keys and `cargo fmt --check`. |
| Playwright browser suite | 109 passed, including four new compaction frequency, migration and subagent regressions. |
| Rust library suite | 136 passed, 6 optional tests ignored, no failures. |
| Packaged memory MCP smoke test | 11 scenarios passed with 33 RPC requests against the 0.6.4 executable and isolated temporary storage; no model requests. |
| Windows installers | x64 NSIS/MSI generated; version 0.6.4, publisher, containers, bundled license and unchanged MSI upgrade code verified. |
| Release integrity | SHA-256 manifest includes both installers and LICENSE. Generated artifacts remain outside source control. |

The new scenarios keep a context of 250,000 tokens after compaction and confirm
both providers wait for five accepted prompts before the next token-triggered
compaction, including after restart. Migration exercises unversioned old defaults
from the localStorage cache and IndexedDB metadata, custom limits, explicit opt-out
and a versioned explicit selection of the old pair. A 240,000-character subagent
reply remains in the transcript without changing the main measured token count.
Existing compaction sequencing, cancellation, history and composer layout coverage
also passes. Browser tests mock provider boundaries; these checks do not establish
live paid provider behavior or an interactive clean-machine upgrade. Providers
retain native compaction and model context limits. Installers remain unsigned.
GitHub CI validates the release branch independently before publication.

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

The graph and agent fixtures use synthetic data rather than a personal project or provider account.

## Scope and remaining validation

Browser tests verify the UI against mocked desktop commands. They do not authenticate providers, send prompts or establish live agent collaboration. Four optional native tests that require installed clients or account integrations were ignored; live provider checks were not rerun for this change. Recorded subagent states remain distinguishable from live session activity in the interface.

The Windows CI workflow passed for the final 0.5.0 documentation commit. The original draft-release job reached packaging but failed because a manually published release already had assets with the same names; that duplicate upload path is addressed in 0.6.0. NSIS/MSI installers were generated locally and remain unsigned. Installing them on a clean machine has not been tested. macOS and Linux behavior has not been validated.

Vite reports existing warnings about large output chunks and mixed static/dynamic imports of Tauri core. These do not prevent the production build; bundle splitting remains a separate performance improvement.
