import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SortableCollection } from "../../../src/components/ordering/SortableCollection";

function SortableLabels() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  return <SortableCollection surface="qa-checkbox-labels" context="local" items={[{ id: "a", name: "Alpha collection" }, { id: "b", name: "Beta collection" }]} getId={item => item.id} getLabel={item => item.name}
    render={item => <label data-drag-primary style={{ display: "flex", alignItems: "center", gap: 12, padding: 20 }}>
      <input type="checkbox" checked={!!checked[item.id]} onChange={event => setChecked(current => ({ ...current, [item.id]: event.target.checked }))} />
      <span>{item.name}</span>
    </label>} />;
}

export function mountSortableLabels() {
  const host = document.createElement("div");
  host.dataset.testid = "sortable-labels-fixture";
  Object.assign(host.style, { position: "fixed", top: "80px", left: "380px", width: "360px", zIndex: "10000", background: "var(--ci-surface)", border: "1px solid var(--ci-border)" });
  document.body.append(host);
  createRoot(host).render(<SortableLabels />);
}
