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
