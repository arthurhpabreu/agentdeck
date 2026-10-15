import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { type ClaudeSession } from "../../store/sessionStore";
import { useEditorBufferStore } from "../../store/editorBufferStore";
import { getSessionEditorGroupIds, useEditorStore } from "../../store/editorStore";
import { EditorGroupPane, type EditorSplitDropData } from "./EditorGroupPane";
import { EditorTabPreview, type EditorTabDragData, type EditorTabStripDropData } from "./EditorTabs";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Undo2 } from "lucide-react";
import { ArrangementControls } from "../ordering/SortableCollection";
import { orderingCopy } from "../ordering/orderingCopy";
import { useAppI18n } from "../../i18n";
import { usePresentationOrder, usePresentationStore } from "../../store/presentationStore";
import { useItemDragSensors } from "../ordering/dragSurface";
import { moveEditorTabToVisualGroup } from "../../services/editorPresentation";

type EditorDropData = EditorSplitDropData | EditorTabStripDropData | EditorTabDragData;

function readDropData(data: unknown): EditorDropData | null {
  if (!data || typeof data !== "object") return null;
  const value = data as { type?: unknown };
  if (value.type === "editor-split" || value.type === "editor-tab-strip" || value.type === "editor-tab") {
    return value as EditorDropData;
  }
  return null;
}

function readDragData(data: unknown): EditorTabDragData | null {
  if (!data || typeof data !== "object") return null;
  const value = data as { type?: unknown };
  if (value.type === "editor-tab") {
    return value as EditorTabDragData;
  }
  return null;
}

function SortableEditorGroup({ id, ids, sessionId, label, children }: { id: string; ids: string[]; sessionId: string; label: string; children: ReactNode }) {
  const { locale } = useAppI18n(), c = orderingCopy(locale);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id, data: { type: "editor-group", groupId: id } });
  return <div ref={node => { setNodeRef(node); setActivatorNodeRef(node); }} data-editor-group-container={id} data-dragging={isDragging}
    {...attributes} {...listeners} role="group" data-drag-item tabIndex={ids.length > 1 ? 0 : -1} aria-label={`${c.drag}: ${c.group} ${label}`} title={c.hint}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); const over = ids[ids.indexOf(id) + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1)]; if (over) usePresentationStore.getState().moveItem("editor-groups", sessionId, ids, ids, id, over); }
      else listeners?.onKeyDown?.(event);
    }} style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}>
    {children}
  </div>;
}

export function EditorSplitHost({
  session,
  onRefreshDiff,
}: {
  session: ClaudeSession | null;
  onRefreshDiff: (sessionId?: string | null) => void;
}) {
  const tabsById = useEditorStore((s) => s.tabsById);
  const { locale } = useAppI18n(), c = orderingCopy(locale);
  const canUndoTabMove = useEditorStore(state => !!state.arrangementHistoryBySession[session?.id ?? ""]?.length);
  const groupsById = useEditorStore((s) => s.groupsById);
  const groupOrderBySessionId = useEditorStore((s) => s.groupOrderBySessionId);
  const ensureSessionGroup = useEditorStore((s) => s.ensureSessionGroup);
  const splitGroupWithTab = useEditorStore((s) => s.splitGroupWithTab);
  const activeGroupIdBySessionId = useEditorStore((s) => s.activeGroupIdBySessionId);
  const [activeDrag, setActiveDrag] = useState<EditorTabDragData | null>(null);

  const dirtyByActiveDragTab = useEditorBufferStore((s) => activeDrag ? s.buffersByTabId[activeDrag.tabId]?.dirty === true : false);
  const sensors = useItemDragSensors();

  useEffect(() => {
    if (!session) return;
    ensureSessionGroup(session.id);
  }, [ensureSessionGroup, session]);

  const groupIds = useMemo(() => {
    if (!session) return [] as string[];
    return getSessionEditorGroupIds(groupsById, groupOrderBySessionId, session.id);
  }, [groupOrderBySessionId, groupsById, session]);
  const visibleGroups = usePresentationOrder("editor-groups", session?.id ?? "none", groupIds, id => id);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDrag(readDragData(event.active.data.current));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.active.data.current?.type === "editor-group" && session) {
      const overGroup = event.over?.data.current?.groupId ?? event.over?.id;
      if (typeof overGroup === "string" && groupIds.includes(overGroup)) usePresentationStore.getState().moveItem("editor-groups", session.id, groupIds, groupIds, String(event.active.id), overGroup);
      return;
    }
    const dragData = readDragData(event.active.data.current);
    const dropData = readDropData(event.over?.data.current);
    setActiveDrag(null);
    if (!dragData || !dropData || !session) return;
    if (dragData.sessionId !== session.id) return;

    if (dropData.type === "editor-split") {
      if (dropData.groupId !== dragData.groupId) return;
      splitGroupWithTab(dragData.groupId, dragData.tabId, dropData.side);
      return;
    }

    if (dropData.type === "editor-tab") {
      if (dropData.groupId === dragData.groupId) {
        const ids = groupsById[dragData.groupId]?.tabIds ?? [];
        usePresentationStore.getState().moveItem("editor-tabs", dragData.groupId, ids, ids, dragData.tabId, dropData.tabId);
        return;
      }
      const targetGroup = groupsById[dropData.groupId];
      if (!targetGroup) return;
      moveEditorTabToVisualGroup(dragData.tabId, dragData.groupId, dropData.groupId, dropData.tabId);
      return;
    }

    if (dropData.type !== "editor-tab-strip") return;
    if (dropData.groupId === dragData.groupId) return;

    const targetGroup = groupsById[dropData.groupId];
    if (!targetGroup) return;
    moveEditorTabToVisualGroup(dragData.tabId, dragData.groupId, dropData.groupId);
  };

  const activeGroupId = session ? activeGroupIdBySessionId[session.id] ?? groupIds[0] ?? null : null;
  const collisionDetection = (args: Parameters<typeof pointerWithin>[0]) => {
    const pointerCollisions = pointerWithin(args);
    const splitCollision = pointerCollisions.find((collision) => collision.data?.droppableContainer.data.current?.type === "editor-split");
    if (splitCollision) return [splitCollision];
    const tabCollision = pointerCollisions.find((collision) => collision.data?.droppableContainer.data.current?.type === "editor-tab");
    if (tabCollision) return [tabCollision];
    if (pointerCollisions.length > 0) return pointerCollisions;
    return closestCenter(args);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveDrag(null)}>
      <div style={{ width: "100%", height: "100%", minHeight: 0, display: "flex", background: "var(--ci-surface)" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        {canUndoTabMove && session && <div className="ad-arrangement-controls"><button type="button" aria-label={c.undoTabs} title={c.undoTabs} onClick={() => useEditorStore.getState().undoSessionArrangement(session.id)}><Undo2 size={13} />{c.undoTabs}</button></div>}
        {groupIds.length > 1 && <ArrangementControls surface="editor-groups" context={session?.id ?? "none"} />}
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}><SortableContext items={visibleGroups} strategy={horizontalListSortingStrategy}>{visibleGroups.map(groupId => <SortableEditorGroup key={groupId} id={groupId} ids={visibleGroups} sessionId={session?.id ?? "none"} label={groupsById[groupId]?.tabIds.map(tabId => tabsById[tabId]?.title).filter(Boolean).join(", ") || "—"}>
          <div style={{ flex: 1, height: "100%", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", borderRight: visibleGroups.indexOf(groupId) < visibleGroups.length - 1 ? "1px solid var(--ci-toolbar-border)" : "none", boxShadow: activeGroupId === groupId && groupIds.length > 1 ? "inset 0 0 0 1px var(--ci-accent-bdr)" : "none" }}>
            <EditorGroupPane
              session={session}
              groupId={groupId}
              showSplitTargets={Boolean(activeDrag) && groupIds.length === 1}
              onRefreshDiff={onRefreshDiff}
            />
          </div>
        </SortableEditorGroup>)}</SortableContext></div></div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <EditorTabPreview
            title={activeDrag.title}
            path={activeDrag.path}
            viewMode={activeDrag.viewMode}
            dirty={dirtyByActiveDragTab}
            preview={tabsById[activeDrag.tabId]?.preview}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
