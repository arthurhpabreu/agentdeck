import { useEditorStore } from "../store/editorStore";
import { applyPresentationOrder, presentationKey, usePresentationStore } from "../store/presentationStore";

/** A drop targets the visible tab order, independently from the group's natural order. */
export function moveEditorTabToVisualGroup(tabId: string, sourceGroupId: string, targetGroupId: string, overTabId?: string) {
  const editor = useEditorStore.getState(), source = editor.groupsById[sourceGroupId], target = editor.groupsById[targetGroupId];
  if (!source || !target || source.sessionId !== target.sessionId || !source.tabIds.includes(tabId)) return;
  const presentation = usePresentationStore.getState();
  const visual = applyPresentationOrder(target.tabIds, presentation.layouts[presentationKey("editor-tabs", targetGroupId)]?.order).filter(id => id !== tabId);
  const targetIndex = overTabId ? visual.indexOf(overTabId) : visual.length;
  visual.splice(targetIndex < 0 ? visual.length : targetIndex, 0, tabId);
  editor.moveTabToGroup(tabId, sourceGroupId, targetGroupId, overTabId ? target.tabIds.indexOf(overTabId) : target.tabIds.length);
  presentation.setOrder("editor-tabs", targetGroupId, visual);
}
