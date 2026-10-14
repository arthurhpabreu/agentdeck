# Architecture

Agent Deck is a Tauri 2 application with a React 19 / TypeScript UI and a Rust backend. Zustand connects UI state with native commands and events.

| Directory | Responsibility |
| --- | --- |
| `src/components/graph` | Shared viewport, knowledge clustering, navigation and translations. |
| `src/components/agents` | Agent list, flow map, task board and activity inspector. |
| `src/components/session` | Chat, composer and execution controls. |
| `src/components/memory` | Memory editing, curation and retrieval controls. |
| `src/store` | Runtime and persisted UI state. |
| `src/services` | Typed native command boundaries and provider adapters. |
| `src-tauri/src` | Lifecycle, PTY, Git, file access, knowledge, memory and observability. |
| `tests/e2e` | Behavioral UI coverage with mocked native commands. |
| `scripts` | Development, build, checks and optional local diagnostics. |

## Knowledge graph

Rust incrementally reads the selected Markdown source, resolves wikilinks and Markdown links inside that source, and caches unchanged notes. The backend returns the complete bounded index and its edges. It never bulk-uploads a vault.

The compact view renders up to 120 notes. The expanded overview aggregates notes into folder nodes with weighted cross-folder edges. Selecting a folder opens its notes. Notes and Connections views bound rendering to 150, 350 or 700 ranked matches; search and the selector cover the whole index. Connection traversal uses an adjacency map and visited set for one to three hops.

Folder clusters use deterministic layouts, avoiding an unbounded force simulation. The shared viewport transforms nodes and edges together, observes container size and supports keyboard pan/zoom. Optional labels keep dense views readable. The inspector reads one original note and ignores superseded async responses.

## Agent flows

Observability combines session lifecycle events, structured chat tools and local provider transcripts. Agent center polls native history every eight seconds while visible. Relationships come from explicit provider metadata. Cycles and missing parents are reattached to the session root to keep agents reachable.

Each session occupies a lane. Columns position agents alongside child agents, each with an attached current-task card. A task board groups the same nodes by ready/paused, working, attention and completed state; it is an observability view, not an editable scheduler.

Native subagent states are labeled as recorded evidence. Active connector animation requires a running main session and a working corresponding agent. Animations can be paused and honor `prefers-reduced-motion`. Missing histories and unsupported providers stay explicit in the inspector.

## Local boundaries

Native commands own filesystem access, process spawning and credential use. Projects, histories, knowledge paths and memory belong to the local machine. Provider authentication stays with the official CLI. UI fixtures contain synthetic paths and tasks.

Keep persisted app identity stable when changing publisher metadata. Optional worktree development deliberately uses an isolated identifier.

## Platform adapters and packaging

The React workspace and Rust domain logic are shared across platforms. OS differences live at explicit boundaries:

| Boundary | Implementation |
| --- | --- |
| Runtime OS, architecture, shell and process PATH | `src-tauri/src/platform.rs`; typed frontend adapter `src/services/platform.ts`. Native facts load before the first UI render. |
| Window lifecycle and monitor coordinates | `src-tauri/src/window.rs`, target-gated Cocoa/Windows APIs and platform-aware window controls. macOS close hides the window; quitting ends the app. |
| CLI processes and terminals | Shared chat/runner/PTY services with native shell arguments and executable-aware PATH. macOS uses a login shell; Command shortcuts preserve terminal Ctrl+C. |
| Provider hook/statusline transport | `native_bridge.rs` provides bounded stdio helpers and Unix sockets on macOS; existing Windows bridges remain platform-gated. No Python runtime is required on the Mac. |
| Installer discovery and verification | One update service selects EXE/MSI on Windows or universal DMG on macOS, checks SHA-256 and package structure, and opens the OS installer. DMG installation is manual. |
| Build configuration | `tauri.conf.json` carries shared identity/version; `tauri.windows.conf.json` and `tauri.macos.conf.json` contain target-specific packaging settings. macOS-only Rust features are target dependencies. |

The application identifier is stable across releases. Preferences and histories are per-user, outside the repository; CLI credentials remain with the official provider. Custom shell startup scripts are not sourced during desktop environment discovery.

## Versioning and releases

Windows and macOS ship under one SemVer and one `v<version>` tag. `package.json` is the version source, synchronized with the Tauri configuration and Rust manifest/lockfile by `corepack pnpm version:set <version>`. `check:version` and tag checks reject mismatches. A platform feature advances the minor version; corrective changes advance the patch version.

CI tests native Windows x64, macOS Apple Silicon and macOS Intel. Release previews can run from a branch without creating a release. Tagged builds gate packaging on those checks, build the Mac app for both architectures, verify signatures/metadata/deployment targets, and run the same packaged universal GUI on both Mac architectures. Only successful platform jobs feed a single draft with Windows installers, universal DMG/application archive, LICENSE and one aggregate SHA-256 manifest. Build artifacts are never source commits.

The release supports ad-hoc signing when Apple credentials are absent. Developer ID distribution requires a complete signing/notarization configuration; the verifier then also checks the notarization ticket and Gatekeeper assessment. An ad-hoc build is explicitly reported as unnotarized.
