import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { RotateCcw, Undo2 } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { presentationKey, usePresentationOrder, usePresentationStore } from "../../store/presentationStore";
import { orderingCopy } from "./orderingCopy";
import "./ordering.css";
import { useItemDragSensors } from "./dragSurface";

export function ArrangementControls({ surface, context, density = false, densityOnly = false, itemCount }: { surface: string; context: string; density?: boolean; densityOnly?: boolean; itemCount?: number }) {
  const { locale } = useAppI18n(), c = orderingCopy(locale), key = presentationKey(surface, context);
  const layout = usePresentationStore(state => state.layouts[key]);
  const canUndo = usePresentationStore(state => !!state.history[key]?.length);
  const currentDensity = usePresentationStore(state => state.density);
  const showArrangement = !densityOnly && (itemCount === undefined || itemCount > 1 || canUndo);
  if (!showArrangement && !density) return null;
  return <div className="ad-arrangement-controls" role="group" aria-label={c.arrange}>
    {showArrangement && <><span>{layout?.order || layout?.positions ? c.manual : c.automatic}</span>
    <button type="button" title={c.undo} aria-label={c.undo} disabled={!canUndo} onClick={() => usePresentationStore.getState().undo(surface, context)}><Undo2 size={13} /></button>
    <button type="button" title={c.reset} aria-label={c.reset} disabled={!layout?.order && !layout?.positions} onClick={() => usePresentationStore.getState().reset(surface, context)}><RotateCcw size={13} /></button></>}
    {density && <select aria-label={c.density} value={currentDensity} onChange={event => usePresentationStore.getState().setDensity(event.target.value as "compact" | "comfortable")}><option value="comfortable">{c.comfortable}</option><option value="compact">{c.compact}</option></select>}
  </div>;
}

function SortableItem({ id, label, move, children, handleTabIndex, optimizeOffscreen }: { id: string; label: string; move: (offset: number) => void; children: (handle: ReactNode) => ReactNode; handleTabIndex?: number; optimizeOffscreen: boolean }) {
  const { locale } = useAppI18n(), c = orderingCopy(locale);
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging, isOver } = useSortable({ id });
  const element = useRef<HTMLDivElement | null>(null);
  const density = usePresentationStore(state => state.density);
  const nodeRef = useCallback((node: HTMLDivElement | null) => { element.current = node; setNodeRef(node); setActivatorNodeRef(node); }, [setNodeRef, setActivatorNodeRef]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !optimizeOffscreen || !globalThis.CSS?.supports?.("content-visibility", "auto")) return;
    // Establish the actual row size before skipping any offscreen content.
    node.style.removeProperty("content-visibility"); node.style.removeProperty("contain-intrinsic-size");
    const measure = (height: number) => {
      if (height <= 0) return;
      node.style.setProperty("contain-intrinsic-size", `auto ${height}px`);
      node.style.setProperty("content-visibility", "auto");
    };
    measure(node.offsetHeight);
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.borderBoxSize;
      measure(Array.isArray(box) ? box[0]?.blockSize ?? node.offsetHeight : node.offsetHeight);
    });
    observer.observe(node);
    return () => { observer.disconnect(); node.style.removeProperty("content-visibility"); node.style.removeProperty("contain-intrinsic-size"); };
  }, [optimizeOffscreen, density]);
  const content = useMemo(() => children(null), [children]);
  return <div ref={nodeRef} className="ad-sortable-item" data-sortable-id={id} data-dragging={isDragging} data-drop-target={isOver && !isDragging}
    {...attributes} {...listeners} role="group" data-drag-item tabIndex={handleTabIndex ?? 0} aria-label={`${c.drag}: ${label}`} title={c.hint}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.altKey && ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); move(event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1); }
      else listeners?.onKeyDown?.(event);
    }}
    style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 50 : undefined }}>{content}</div>;
}

export interface SortableCollectionProps<T> {
  surface: string; context: string; items: T[]; getId: (item: T) => string; getLabel: (item: T) => string;
  render: (item: T, handle: ReactNode) => ReactNode; allIds?: string[]; horizontal?: boolean; toolbar?: boolean;
  className?: string; style?: CSSProperties; onOrder?: (ids: string[]) => void; handleTabIndex?: number; densityControl?: boolean;
}

/** Freeze IDs during interaction, but continue showing live values for those IDs. */
export function SortableCollection<T>({ surface, context, items, getId, getLabel, render, allIds, horizontal = false, toolbar = true, className = "", style, onOrder, handleTabIndex, densityControl = false }: SortableCollectionProps<T>) {
  const ordered = usePresentationOrder(surface, context, items, getId);
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const allAtStart = useRef<string[]>([]);
  const collection = useRef<HTMLDivElement>(null);
  const labelClickCleanup = useRef<(() => void) | null>(null);
  const labelClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLabelClick = () => {
    if (labelClickTimer.current) clearTimeout(labelClickTimer.current);
    labelClickCleanup.current?.(); labelClickCleanup.current = null;
  };
  useEffect(() => () => { if (labelClickTimer.current) clearTimeout(labelClickTimer.current); labelClickCleanup.current?.(); }, []);
  const protectDraggedLabel = () => {
    clearLabelClick();
    const listener = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && collection.current?.contains(target) && target.closest("label[data-drag-primary]") && !target.closest("input")) event.preventDefault();
      clearLabelClick();
    };
    // DndKit stops propagation, but a label's native checkbox activation also
    // needs its default cancelled. Same-document capture listeners still run.
    document.addEventListener("click", listener, true);
    labelClickCleanup.current = () => document.removeEventListener("click", listener, true);
  };
  const finishLabelDrag = () => { labelClickTimer.current = setTimeout(clearLabelClick, 50); };
  const density = usePresentationStore(state => state.density);
  const sensors = useItemDragSensors();
  const visibleIds = dragIds ?? ordered.map(getId), byId = new Map(items.map(item => [getId(item), item]));
  const move = (active: string, over: string, full = allIds ?? items.map(getId)) => {
    usePresentationStore.getState().moveItem(surface, context, full, visibleIds, active, over);
    const order = usePresentationStore.getState().layouts[presentationKey(surface, context)]?.order;
    if (order) onOrder?.(order);
  };
  return <div ref={collection} className={`ad-sortable-collection ${className}`} data-surface={surface} data-density={density} data-horizontal={horizontal} data-arranging={!!dragIds} style={style}>
    {toolbar && <ArrangementControls surface={surface} context={context} density={densityControl} itemCount={items.length} />}
    <DndContext sensors={sensors} collisionDetection={closestCenter} autoScroll onDragStart={event => { if (!(event.activatorEvent instanceof KeyboardEvent)) protectDraggedLabel(); allAtStart.current = allIds ?? items.map(getId); setDragIds(ordered.map(getId)); }} onDragCancel={() => { finishLabelDrag(); setDragIds(null); }} onDragEnd={({ active, over }) => {
      if (over && active.id !== over.id) move(String(active.id), String(over.id), allAtStart.current);
      setDragIds(null);
      finishLabelDrag();
    }}><SortableContext items={visibleIds} strategy={horizontal ? horizontalListSortingStrategy : verticalListSortingStrategy}>
      <div className="ad-sortable-content">{visibleIds.map(id => {
        const item = byId.get(id); if (!item) return null;
        return <SortableItem key={id} id={id} label={getLabel(item)} handleTabIndex={handleTabIndex} optimizeOffscreen={!horizontal} move={offset => { const index = visibleIds.indexOf(id); const over = visibleIds[index + offset]; if (over) move(id, over); }}>{handle => render(item, handle)}</SortableItem>;
      })}</div>
    </SortableContext></DndContext>
  </div>;
}
