# Selectable knowledge sources

The global catalog is a reusable registry of Markdown/Obsidian folders with stable IDs and editable names. Registering a folder does not enable it for any project. Removing an association leaves the original Markdown files intact.

Project selection contains `sourceIds`, `memoryCollectionIds` and an explicit `personalPreferences` opt-in. A conversation uses either project inheritance or its own selection. An explicit custom selection with empty arrays grants no shared vaults or collections. Worktrees resolve to the canonical repository path; the same remote URL alone does not combine projects.

Vault modes are `disabled`, `query` and `automatic`. Query mode permits an authorized tool read without preloading. Optional relative folder/note restrictions apply to search, known document IDs, previews, graphs and resolved links. Document IDs contain both source ID and relative path, so equal paths in different vaults remain distinct.

The Rust policy resolves the requesting project and conversation before automatic retrieval or MCP operations. Asking a tool to inspect another project does not enlarge the requesting conversation's vault selection. Active helpers reload the registry on each call. Effective revision tokens depend on the selected sources, restrictions, collections and inheritance; unrelated project changes do not invalidate a custom conversation.

Prepared context is checked again before delivery, including current record revisions, eligibility and document containment. Capture stays with its originating project. Repeated statements become review candidates; they are not automatically promoted to global preferences. Universal personal preference approval is explicit, and selecting a vault does not enable unrelated global SQLite records. Shared collections provide separate explicit grants.

The sources panel follows the conversation owner and shows prepared versus delivered evidence. Delivery revisions and history provenance survive application restart. Legacy or unprovenanced history remains subject to review even after a new turn uses current sources. A changed selection can therefore show that older context remains in the provider; a fresh conversation with reviewed context is the recovery path. Its original history remains readable, and the full old archive is not automatically attached to the new agent.

Legacy global preferences initially have no universal approval. In Shared memory → Global, open a note's History and applicability controls and explicitly confirm universal personal scope. Selecting a stack restriction revokes that approval. The confirmation preserves the original note ID, origin and revision history; a project/conversation must also opt into personal preferences before retrieval.

Every context transfer into a new conversation uses a reviewed textual draft. Known-source evidence does not automatically forward the archived transcript; legacy archive-reading instructions and known archive references are removed from the proposed draft. The original files and transcript remain available locally. Source selection does not rewrite historical project notes; existing memories can be inspected and corrected through the memory panel.

## Migration and rollback

Knowledge configuration uses schema version 2. Migration makes a verified, durable `v1.backup.json` sibling before replacing associations atomically. Legacy explicitly configured project roots retain their association; the former global root becomes a catalog item awaiting selection. A partial or mismatched existing backup stops migration rather than overwriting evidence.

Rollback archives the current associations as `v2.rollback.json` and restores the verified legacy configuration. Reopening it with 0.8 migrates again; use the older application when testing a full version rollback. SQLite migrations preserve existing records, IDs, versions and delivery history. Original vault folders are never moved, rewritten or deleted by association migration.

This policy governs Agent Deck's context delivery. Provider filesystem access, external MCP servers and global native instructions are independently configured. The UI exposes this boundary alongside source selection.
