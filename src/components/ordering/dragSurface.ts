import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { SyntheticEvent } from "react";

/** Selection buttons opt in; actions and editors keep native input. Moving before the hold preserves text selection. */
export function isDragSurface(event: Pick<SyntheticEvent, "target" | "currentTarget"> & { shiftKey?: boolean }) {
  const target = event.target instanceof Element ? event.target : null;
  const root = event.currentTarget instanceof Element ? event.currentTarget : null;
  if (!target || !root || event.shiftKey || target.closest("[data-drag-item]") !== root) return false;
  if (target.closest("input, textarea, select, option, a[href], button:disabled, [aria-disabled='true'], [contenteditable='true'], [data-no-drag], .cm-editor, .xterm")) return false;
  const control = target.closest("button, label, summary, [role='button'], [role='checkbox'], [role='slider'], [role='textbox']");
  return !control || control === root || control.hasAttribute("data-drag-primary");
}

export class ItemMouseSensor extends MouseSensor {
  static activators = MouseSensor.activators.map(activator => ({ ...activator,
    handler: (...args: Parameters<typeof activator.handler>) => isDragSurface(args[0]) && args[0].button === 0 && activator.handler(...args),
  }));
}

export class ItemTouchSensor extends TouchSensor {
  static activators = TouchSensor.activators.map(activator => ({ ...activator,
    handler: (...args: Parameters<typeof activator.handler>) => isDragSurface(args[0]) && activator.handler(...args),
  }));
}

export function useItemDragSensors() {
  return useSensors(
    useSensor(ItemMouseSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(ItemTouchSensor, { activationConstraint: { delay: 260, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}
