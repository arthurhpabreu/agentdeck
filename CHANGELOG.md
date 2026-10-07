# Changelog

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
