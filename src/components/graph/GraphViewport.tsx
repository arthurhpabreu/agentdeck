import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import "./graphViewport.css";

export interface GraphControls { zoomIn: string; zoomOut: string; fit: string; hint: string }

/** Shared world coordinates keep cards and connectors aligned while panning. */
export function GraphViewport({ width, height, label, controls, children, resetKey = "", focusTarget }: {
  width: number; height: number; label: string; controls: GraphControls;
  children: ReactNode; resetKey?: string; focusTarget?: { x: number; y: number; key: string };
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; id: number } | null>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const fit = useCallback(() => {
    const box = viewport.current;
    if (!box) return;
    const scale = Math.max(.08, Math.min(1, (box.clientWidth - 48) / width, (box.clientHeight - 48) / height));
    setCamera({ scale, x: (box.clientWidth - width * scale) / 2, y: (box.clientHeight - height * scale) / 2 });
  }, [width, height]);
  useEffect(() => {
    const box = viewport.current;
    if (!box) return;
    const observer = new ResizeObserver(fit);
    observer.observe(box); fit();
    return () => observer.disconnect();
  }, [fit, resetKey]);
  useEffect(() => {
    const box = viewport.current;
    if (box && focusTarget) setCamera({ scale: 1, x: box.clientWidth / 2 - focusTarget.x, y: box.clientHeight / 2 - focusTarget.y });
  }, [focusTarget?.key, focusTarget?.x, focusTarget?.y]);
  const zoom = useCallback((factor: number, cx?: number, cy?: number) => {
    const box = viewport.current;
    if (!box) return;
    const x = cx ?? box.clientWidth / 2, y = cy ?? box.clientHeight / 2;
    setCamera(old => {
      const scale = Math.max(.08, Math.min(3, old.scale * factor));
      const ratio = scale / old.scale;
      return { scale, x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio };
    });
  }, []);
  useEffect(() => {
    const box = viewport.current;
    if (!box) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = box.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - rect.left, event.clientY - rect.top);
    };
    box.addEventListener("wheel", wheel, { passive: false });
    return () => box.removeEventListener("wheel", wheel);
  }, [zoom]);
  return <div className="ad-graph-shell">
    <div className="ad-graph-viewport" ref={viewport} role="group" aria-label={label} tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest("button, [role=button], input, select, a")) return;
        drag.current = { x: event.clientX, y: event.clientY, tx: camera.x, ty: camera.y, id: event.pointerId };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.id === event.pointerId) setCamera(old => ({ ...old, x: start.tx + event.clientX - start.x, y: start.ty + event.clientY - start.y }));
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (["+", "=", "-", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
        if (event.key === "+" || event.key === "=") zoom(1.2);
        else if (event.key === "-") zoom(1 / 1.2);
        else if (event.key === "0") fit();
        else if (event.key.startsWith("Arrow")) setCamera(old => ({ ...old, x: old.x + (event.key === "ArrowLeft" ? 50 : event.key === "ArrowRight" ? -50 : 0), y: old.y + (event.key === "ArrowUp" ? 50 : event.key === "ArrowDown" ? -50 : 0) }));
      }}>
      <div className="ad-graph-world" style={{ width, height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>{children}</div>
    </div>
    <div className="ad-graph-toolbar" role="group" aria-label={label}>
      <span>{controls.hint}</span><button type="button" onClick={() => zoom(1 / 1.2)} title={controls.zoomOut} aria-label={controls.zoomOut}><Minus size={15} /></button>
      <output>{Math.round(camera.scale * 100)}%</output><button type="button" onClick={() => zoom(1.2)} title={controls.zoomIn} aria-label={controls.zoomIn}><Plus size={15} /></button>
      <button type="button" onClick={fit} title={controls.fit} aria-label={controls.fit}><Maximize size={15} /></button>
    </div>
  </div>;
}
