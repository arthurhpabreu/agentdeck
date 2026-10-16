# Visual organization in Agent Deck

Agent Deck 0.8 stores manual presentation independently from project identity, provider execution, file paths and selected knowledge sources. Selecting a project changes focus without moving its navigation entry. Streaming and telemetry can update a card's contents without changing an established manual order.

## Collection inventory

| Collection | Stable identity and context | Presentation behavior |
| --- | --- | --- |
| Project navigation | Workspace ID, navigation surface | Automatic groups: **Waiting for you** (unread approvals, questions, errors or finished responses), **Running**, **Recent** (activity within seven days, newest first) and **Other projects**. Only Other projects accepts drag or keyboard order; focus leaves positions unchanged and group headers collapse persistently. |
| Sessions | Session ID, workspace ID | Free manual order across execution states; reset restores status priority and existing automatic order. |
| Terminal tabs | Widget and tab IDs, workspace ID | Visual tab order preserves PTY IDs, ownership, selected tab and settings. |
| Editor tabs | Tab ID, editor group ID | Reordering preserves paths and buffers; existing split and move-to-group actions remain available. |
| Editor groups | Group ID, session ID | Order groups without changing session ownership or the files in each group. |
| Open editors sidebar | Tab ID, session ID | Independent visual navigation order. |
| File explorer | Node ID, session and actual parent directory | Order siblings; a directory moves with its expanded children. No filesystem operation is triggered. |
| Source control sections | Committed or working tree ID, session ID | Reorganize visual sections and their status groups. |
| Source control files | File path, session and actual status group | Reorder review navigation without staging, unstaging or discarding. |
| Diff files | File path, session ID | Reorganize review sequence; hunk and line contents retain file order. |
| Agent lists | Agent key, monitor or real parent key | Roots and their child lists are sortable; provider parent references remain unchanged. |
| Agent task board | Agent key, real status column or manual board | Status view orders within meaningful columns. Manual view allows free arrangement with actual status and parent labels. |
| Agent map | Agent key, map surface | Save card positions in world coordinates, including when the viewport is zoomed. Connectors follow the real relationships. |
| Needs You | Event ID, inbox | Order unread actionable events without changing timestamps or confirmation state. |
| Quick navigation | Entry ID, result group and workspace | Organize result groups; keyboard navigation uses the same displayed order. |
| Welcome recent sessions | Session ID, workspace | Reorder the displayed recent collection without modifying creation or activity times. |
| Welcome projects | Workspace ID, welcome surface | Independent organization of other project entries. |
| Recoverable worktrees | Canonical worktree path, repository | Reorder entries without opening or cleaning a worktree. |
| Worktree notices | Notice path, repository | Reorganize notices while preserving cleanup evidence. |
| Vault catalog and source selectors | Source ID, global catalog or project/conversation | Sorting is independent from source selection and access policy. |
| Shared memory collections | Collection ID, policy context | Organize choices without enabling a collection. |
| Memory notes and archives | Record ID, project or collection | Preserve record identity, revisions, pinning and provenance. |
| Suggested preferences and project catalog | Candidate or project ID, catalog | Preserve approval state and project associations. |
| Knowledge notes and connections | Source-scoped document ID, graph context | Organize navigation while every read remains subject to the source policy. |
| Retrieval results | Result ID, project/conversation | Keep scores and reasons intact while changing presentation. |
| Conversation checkpoints | Checkpoint ID, session ID | Organize recoverable snapshots without rewriting original history. |

Messages, execution events, file lines, memory revisions and tool timelines retain their chronological or source order. Provider/model choices, status filters, theme choices, color palettes and other fixed form options remain semantic controls.

## Interaction and persistence

The grip activates a drag after seven pixels, allowing normal clicks and text selection. Destination marks and auto-scroll assist mouse movement. Space starts keyboard dragging, arrows choose the destination, and Escape cancels; Alt plus an arrow moves an item one place immediately. Each collection exposes Undo and Automatic order controls. Map handles also accept arrow keys, with Shift increasing the movement step.

Manual order is a list of stable IDs keyed by surface and context. A filtered move replaces only the visible slots, keeping hidden items in their original slots. Items that have never appeared in the saved order append after known items. Renaming does not change identity. The presentation store persists layouts, view modes (including collapsed project groups) and the board's presentation mode; its last twenty undo states per context remain in memory.

Map movement divides pointer distance by the actual viewport scale. The first saved map arrangement captures the remaining card positions, keeping telemetry from recalculating established positions. Escape discards the in-progress preview; pointer release commits one snapshot. Viewport size changes or explicit Fit can adjust the camera without changing saved world coordinates.

Lists use one comfortable density. A project's status line names the most urgent unread action, the running task or its last activity, and shows its path on hover; a pulsing dot (static under reduced motion) marks running or waiting projects. Project activity combines when sessions start running, conversation messages, session creation and unread attention events. Long names remain available through labels and tooltips, with selected and running states represented separately. The ordering controls provide English, Portuguese and Spanish copy.

## Rendering and integration

[SortableCollection](../src/components/ordering/SortableCollection.tsx) routes all reordering through [presentationStore](../src/store/presentationStore.ts). Callers provide their full unfiltered ID set when showing a filtered or windowed subset. `applyPresentationOrder` supplies the same order to keyboard navigation, and `moveVisiblePresentation` preserves hidden slots.

Dragging freezes displayed IDs until drop or cancellation, while live values for those IDs can still update. Pointer transforms remain in the sortable wrappers; memoized bodies avoid rebuilding their contents for transform-only updates. Persistent storage changes on completed moves, keyboard moves, resets and undo, never on every pointer pixel.

Vertical collections progressively skip offscreen layout and painting when the browser supports `content-visibility`. A ResizeObserver measures the actual row height before activating containment and applies size changes on the next animation frame, so writing the observed row never re-enters layout; no estimated height substitutes for a measured row. Dragging makes the collection visible for accurate target measurement. Unsupported browsers retain normal rendering. Horizontal tab strips retain ordinary layout, and terminal process lifetime is handled by the separate PTY runtime.

Editor metadata uses a separate persisted layout; draft contents continue to belong to editor buffers and file-save validation. Drops into another editor group target its displayed tab order. Undo tab move restores group assignments while retaining tabs opened since the move, keeping closed tabs closed and preserving current unsaved buffers. Native mirrors include the presentation and editor layout keys so a missing browser copy can be restored at startup.

## Verification

[Ordering tests](../tests/e2e/ordering.spec.ts) cover filtered and offscreen slots, new items, context-local undo, focus without reordering, rename/reload persistence, cross-status session moves, cancellation during streaming, provider identities, world-coordinate map movement and editor tab order without file writes. Existing agent, editor and worktree tests cover hierarchy, readable small windows, tool evidence, native navigation, draft preservation and cleanup confirmation.
