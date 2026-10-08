# Changelog

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
