import { useState, type ReactNode } from "react";

/** Keep the logical collection intact and mount only the visible rows plus overscan. */
export function WindowedRows<T>({ items, rowHeight = 20, height = 420, render }: { items: T[]; rowHeight?: number; height?: number; render: (item: T, index: number) => ReactNode }) {
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 12);
  const end = Math.min(items.length, start + Math.ceil(height / rowHeight) + 24);
  return <div className="ad-windowed-rows" style={{ height: Math.min(height, items.length * rowHeight), overflow: "auto", position: "relative" }} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
    <div style={{ height: items.length * rowHeight, position: "relative" }}><div style={{ position: "absolute", top: start * rowHeight, minWidth: "100%" }}>
      {items.slice(start, end).map((item, index) => <div key={start + index} data-virtual-row={start + index} style={{ height: rowHeight }}>{render(item, start + index)}</div>)}
    </div></div>
  </div>;
}
