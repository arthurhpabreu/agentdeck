# Changelog

## 0.11.0 — 2026-10-15

### Added

- Projects organize themselves into **Waiting for you**, **Running**, **Recent**
  and **Other projects**. Each project shows its most urgent pending action, the
  running task or its last activity, with a status dot. Groups collapse and stay
  collapsed; only Other projects keeps a manual arrangement.
- **Clean all** in preserved worktrees removes every eligible worktree of the
  selected project after one confirmation, with progress and freed space.
  Commits stay on their branches, uncommitted changes go to the repository's
  `git stash`, and commits without a branch get an `agentdeck/archive/*` branch.

### Changed

- Removing a session archives its worktree the same way instead of preserving
  the whole folder when it only contains dependencies or builds, so worktrees
  no longer accumulate gigabytes of `node_modules` and `target` folders.
- Worktrees that agents create with descriptive names inside the Agent Deck
  worktree folder are listed and can be cleaned.
- Lists use a single comfortable density; the density selector was removed.
- Preserved worktrees opens on the current project and drops notices for
  folders that no longer exist.

### Fixed

- Clicking a completion notification on Windows opens the finished session,
  switching to its project. Notification titles name the project.
- A response that finishes in the conversation on screen no longer stays in
  Needs you.
- Opening Needs you or long lists no longer reports "ResizeObserver loop
  completed with undelivered notifications" as a frontend error.

## 0.10.0 — 2026-10-15

### Added

- Optional task distribution across Codex and Claude Code models, independent of
  RTK. The chosen main model, effort, Fast and Ultra remain unchanged; available
  Luna/Haiku agents handle bounded exploration, with stronger models reserved for
  occasional advice. Running agents keep their settings.
- Model distribution shows no savings estimate yet, keeping provider-reported
  usage separate from RTK measurements and accounting for additional advisor use.

### Changed

- Hold item bodies to rearrange lists, tabs, cards and widgets without dotted
  grips. Clicks, interactive controls, text selection, touch scrolling, keyboard
  movement, cancellation and undo retain their functions.
- The left sidebar can reach half the window width, with pointer and keyboard
  resizing and a saved preference that adapts to smaller windows.
- Knowledge opens Documents first, separates project/conversation Sources from
  the Vault catalog, and moves advanced settings into details. Search precedes
  graphs and diagnostics, which load when opened; existing source policies remain.

### Fixed

- Claude Code chats reconcile grouped follow-up messages with the UUIDs consumed
  by each native result and its session state, avoiding a finished response being
  held open by an incorrect count of pending messages.
- Completion preserves real background commands and agents. Retained Claude
  transports are eligible for cleanup only after verified idle, consumed input
  and an empty native task ledger on a compatible CLI.
- Late tool progress cannot reopen completed calls. The activity footer explains
  when native background tasks remain, while confirmed completion clears running
  indicators and interrupted/error results retain their status.
- Optional MCP startup OAuth refresh messages, including Miro, become sanitized
  execution diagnostics. Explicit authentication failures for requested actions
  remain visible and actionable.

## 0.8.2 — 2026-10-15

### Fixed

- Claude Code conversations now wait for the native process to exit after a
  response, allowing background commands, renders and agents to finish and report
  their results. The ten-second cleanup applies only to completed Codex transports.

## 0.7.0 — 2026-10-14

### Added

- Universal macOS application and DMG for Apple Silicon and Intel, targeting macOS 11+ and published alongside Windows installers in one release.
- Native platform and shell adapters, Command shortcuts, Mac window controls and multi-monitor positioning.
- macOS CLI environment initialization and shared executable-aware PATH for native processes.
- Native Unix hook/statusline helpers without a Python dependency; Claude Keychain-aware usage fallback.
- Verified DMG updates with localized manual-install instructions and active-task guards.
- Native CI for Windows, Apple Silicon and Intel; packaged universal-app launch checks on both Mac architectures.

### Changed

- Shared Tauri configuration now uses platform overlays and target-specific Rust features.
- Portable Node build/dev wrappers replace shell-dependent command invocation.
- SemVer synchronization, tag validation and aggregate release checksums ensure one consistent version across platforms.
- Integration authentication notices appear briefly for a new error and then disappear; duplicate events and restored history do not keep the banner visible.
- macOS startup and restored window bounds fit the display's visible work area, keeping controls clear of the menu bar and Dock on smaller screens.

## 0.6.8 — 2026-10-14

### Added

- **New chat with context** for Claude Code and Codex saves the complete locally
  recorded transcript and prepares an editable continuation draft in a separate
  conversation. The original chat, goal, model settings and worktree are preserved.
- Large continuation archives use lossless byte parts and a manifest instead of
  shortening the saved history or loading every old message into the next prompt.
- Conversation context controls show the provider-reported model window, reserved
  response/tool capacity, effective compaction threshold and projected draft size.

### Changed

- Automatic compaction considers the next request, conversation goal and attachment
  paths. Reported context-window pressure and substantial new input bypass the
  five-prompt interval after compaction.
- Requests and live follow-up messages whose estimated input alone exceeds a known
  model window stay editable without interrupting the current response.
- Codex resumes native threads without retransmitting their complete turn history.
- Chat history pages bound rendered text as well as message count. Large restored
  conversations use smaller pages, with previous messages still accessible and
  local archives unchanged.

### Fixed

- MCP OAuth warnings and diagnostic output no longer replace the agent's work
  state or hide inactivity. Connection retries remain separate from fatal errors.
- Provider negotiation, stalled compaction and unconfirmed input acknowledgments
  have recovery deadlines that preserve the conversation without replaying tasks.
- A transport left open after confirmed native completion is closed without
  discarding the result. Running model turns and tools remain unaffected.
- Measured context and model windows follow the main agent, including after
  compaction, rather than inheriting subagent measurements.
- Failed history reads or archive writes cannot create an incomplete continuation;
  failure to persist the new chat rolls back its creation.

## 0.6.7 — 2026-10-09

### Added

- Optional Telegram completion alerts for the official Android and iPhone/iPad
  apps. Settings → System → Notifications connects a personal bot through a
  private pairing link that expires after 10 minutes.
- Telegram controls include an independent opt-in toggle, an explicit test,
  reconnect and disconnect. Automatic alerts also respect the main Notifications
  switch and reuse the existing successful main-response completion detector.
- Bot tokens are saved in the operating system's credential store after pairing.
  Alerts contain only a short completion notice, without prompts, response
  content, project paths or progress updates.

## 0.6.6 — 2026-10-08

### Changed

- Chat tool cards start collapsed, including running tools, failures and approval
  requests. Click the summary to inspect command details and output.
- Incoming output and status changes preserve the user's open/closed choice;
  reloading the app starts with compact cards.
- Removed the redundant agent activity disclosure. The inactivity notice now
  appears after two minutes without substantive activity.
- Desktop notifications occur once after a successful top-level response finishes
  and no queued input remains. Tools, progress, compaction, errors, interruption
  and generic terminal waiting events no longer trigger completion notifications.
- Documents and Shared Memory share scope controls, project selection and search
  styling. Settings switches support keyboard activation and themed controls use
  consistent spacing and colors.
- Projects offer 18 color presets, a native color picker and validated hex input.
  Existing project colors can be edited without cycling through every preset.
- Markdown indexing supports up to 1 MiB per note, with specific diagnostics for
  truncated notes, unreadable files/folders and index limits. The total limits
  remain 3,000 notes and 16 MiB of text.
- The RTK panel describes Claude and Codex separately, including Codex's native
  hook authorization requirement. Direct RTK commands remain available through
  agent guidance independently of automatic hook rewriting.

### Fixed

- Codex RTK setup no longer duplicates inherited user hooks in session arguments;
  repeated setup preserves explicit hooks without adding the adapter twice.
  Re-enabling economy also refreshes guidance in existing conversations.
- Vaults with exactly 3,000 Markdown notes no longer report a note-count limit
  merely because ignored files remain. Larger notes within the new per-note limit
  are indexed in full, including searchable content at their end.

## 0.6.5 — 2026-10-08

### Changed

- Chat shows terminal commands, available output, working directories and exit
  status, with activity timestamps and process recovery controls for quiet turns.
- The compact composer keeps commands and skills above the input and groups
  settings, attachments and response actions in one row.
- Long turns archive completed tools, batch streaming updates and recover late
  output without losing message identity. Slow compaction reports its state and
  continues waiting for provider confirmation.
- Memory retrieval shows the selected sources and distinguishes prepared context
  from delivery. Vault diagnostics explain unavailable folders and partial indexes
  while preserving results from healthy sources.
- Preserved session worktrees remain discoverable after removing projects or
  restarting. Cleanup requires confirmation, rechecks Git state and keeps branches;
  dirty, locked, detached or active worktrees cannot be cleaned through recovery.
- The README describes the product and setup; version history stays in release notes.

### Fixed

- Editor saves preserve text typed during a pending write; failed writes retain
  drafts, and closing unsaved tabs requires confirmation.
- Memory drafts survive panel navigation. Export destinations remain bound to
  their validated previews, including after failed folder selections.
- Markdown indexing handles encoded fragments and fenced code correctly, and
  connected-note reads reject deleted files or paths outside the selected source.
- Large terminal input no longer overflows JavaScript argument limits.
- Worktree cleanup preserves ignored/untracked files, and Windows path variations
  no longer leave stale recovery notices after successful cleanup.

## 0.6.4 — 2026-10-08

### Changed

- Automatic compaction defaults increase from 20 prompts / 64,000 context tokens
  to 50 prompts / 200,000 tokens. Existing enabled policies using exactly the old
  default pair migrate once; other custom limits and explicit opt-out are retained.
- After confirmed compaction, the application waits for five accepted prompts
  before requesting another compaction by token count. Prompt thresholds still
  apply, and providers retain their own native context protection.

### Fixed

- Subagent output no longer inflates the main agent's estimated context or changes
  a measured main-context reading into an estimate. Subagent messages still appear
  in the conversation and are saved in the local archive.
- Browser regressions cover high post-compaction context, both providers, restart
  persistence, cache/archive policy migration, custom limits and subagent isolation.

## 0.6.3 — 2026-10-08

### Fixed

- Chat composer controls no longer shift or get squeezed during context compaction.
  Model, effort, execution mode and access settings occupy their own row; attachments,
  context settings, stop and send actions stay aligned below it.
- The context control keeps a stable label while the existing progress indicator
  displays compaction status. Its settings panel stays within compact windows.
- Browser regression coverage checks selector stability, action alignment, overlap
  and settings visibility at three window widths during compaction.

## 0.6.2 — 2026-10-08

### Added

- Automatic provider context compaction in Claude Code and Codex chats before
  the next request, after 20 prompts or approximately 64,000 context tokens.
  Per-conversation controls configure either threshold or disable automation.
- Confirmed native compaction keeps the existing provider session. Additional
  input queues during compaction. Failures retain the pending request and history;
  a 180-second compaction timeout prevents waiting indefinitely.
- A local IndexedDB history archive with incremental asynchronous saves, automatic
  migration from existing chats, and eviction only after a successful archive write.
- History navigation and search render up to 80 messages at a time; Markdown
  export includes the complete saved transcript and attachments' names.

### Fixed

- Streaming no longer serializes every conversation into localStorage repeatedly.
  The startup cache is bounded and the archive retains the full history.
- Stream bursts are coalesced, unchanged Markdown is memoized, and unusually
  large replies display as selectable text to avoid expensive Markdown parsing.
- Repeated reasoning notifications no longer accumulate `Thinking…` diagnostics.
- Context thresholds use the latest reported model context or a labeled byte-based
  estimate, independently of cumulative billable usage. Compaction preserves usage
  totals and re-arms local memory/RTK guidance delivery.

The archive and interface performance changes apply to structured chat. Native
terminal providers retain their own context handling. Browser tests mock native
execution; native protocol tests cover compaction sequencing without paid inference.

## 0.6.1 — 2026-10-08

### Added

- Agent Deck checks official stable GitHub releases at startup. Click the update
  badge to download a verified installer, then explicitly open it from System
  settings. The download uses the installed package type (NSIS or MSI).
- Installer downloads verify release URLs, size, container and published SHA-256;
  integrity is checked again before opening. Installation is blocked while agents
  or terminals are running. Offline checks and failed downloads can be retried.
- Rename sessions from the session list or conversation header, with a focused
  name editor, Enter to save, Escape to cancel and English/Portuguese/Spanish labels.
- Custom session names persist across restarts and recovery, and remain stable
  when sending chat messages or launching the native terminal. Renaming keeps
  the existing conversation, provider binding, worktree and history.

### Fixed

- Large prompts no longer disable automatic memory retrieval with
  `Query exceeds limit`. Retrieval samples the opening and ending of the prompt
  within an 8,000-byte UTF-8-safe query, while the provider receives the full prompt.
- Project memory and global Markdown/Obsidian documents continue to share the
  configured context budget and delivery deduplication for large prompts.

### Compatibility

- Existing sessions keep automatic naming until explicitly renamed. The optional
  custom-name flag requires no data migration. Application identity, storage keys
  and Windows installer upgrade code are unchanged from 0.6.0.

## 0.6.0

### Added

- Searchable command and skill picker in structured chats, native startup inputs
  and terminal follow-ups, with keyboard insertion, source badges and refresh.
- Existing user/project commands and skills, enabled Claude plugin definitions,
  native Codex skill discovery, and Gemini extension definitions.
- Local structured chat controls for model, effort, fast mode, planning and status.
- Explicit native Codex skill input on initial and additional turns; server-side
  path resolution prevents forged frontend skill paths.
- Session-preserving terminal handoff for interactive-only commands, without
  sending slash commands as positional model prompts.

### Changed

- Agent Deck 0.6.0 uses Arthur Abreu's Personal Use License: personal,
  non-commercial use and private modifications are permitted; resale, commercial
  use and redistribution require written permission. The 0.5.0 Apache grant is
  preserved for earlier copies. Third-party component licenses remain separate.
- License metadata and installer resources now include the current license.

## 0.5.0

### Added

- Expanded knowledge graph with folder overview, full-index search, folder filters and one- to three-hop connection exploration.
- Shared pan, zoom, keyboard and fit controls, with selectable rendering limits of 150, 350 and 700 notes.
- Agent flow map with separate agent/task cards, session lanes, animated delegation connectors and a task board.
- Animation pause controls and system reduced-motion support.
- Title-bar indicator for confirmed CLI updates with direct access to update management.
- English setup, architecture, testing and contributor documentation; Windows CI and draft installer releases.

### Changed

- Graph data includes the complete bounded local index, including low-degree and isolated notes.
- Agent center opens in the flow map; the session list and detailed provider evidence remain accessible.
- Removed obsolete application namespaces and migration bridges. Agent Deck uses its own persisted state and runtime directories.
- Repository excludes private runtime data and historical local QA while retaining reproducible project inputs.

## 0.4.9

- Automatic memory selection and derived conversation context.
- Per-conversation access controls and streamed follow-up input.
- Local memory, Markdown and Obsidian integration, official CLI model selection, usage and update management.
