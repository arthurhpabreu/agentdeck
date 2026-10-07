import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { chatCopy } from "./chatCopy";

export function SketchDialog({ onClose, onAttach }: { onClose: () => void; onAttach: (file: File) => void }) {
  const { locale } = useAppI18n(); const c = chatCopy(locale);
  const canvas = useRef<HTMLCanvasElement>(null); const drawing = useRef(false); const dialog = useRef<HTMLDialogElement>(null);
  const clear = () => { const context = canvas.current?.getContext("2d"); if (context) { context.fillStyle = "#f7faf8"; context.fillRect(0, 0, 900, 500); } };
  useEffect(() => { clear(); dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="ad-sketch-dialog" onCancel={onClose} aria-label={c.sketchTitle}>
    <header><strong>{c.sketchTitle}</strong><button className="ad-icon-button" aria-label={c.cancel} onClick={onClose}><X size={18} /></button></header>
    <canvas ref={canvas} width={900} height={500} aria-label={c.sketchTitle} onPointerDown={e => {
      e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const rect = e.currentTarget.getBoundingClientRect(); const ctx = e.currentTarget.getContext("2d")!;
      ctx.beginPath(); ctx.moveTo((e.clientX - rect.left) * 900 / rect.width, (e.clientY - rect.top) * 500 / rect.height); ctx.strokeStyle = "#087b49"; ctx.lineWidth = 4; ctx.lineCap = "round";
    }} onPointerMove={e => { if (!drawing.current) return; const rect = e.currentTarget.getBoundingClientRect(); const ctx = e.currentTarget.getContext("2d")!; ctx.lineTo((e.clientX - rect.left) * 900 / rect.width, (e.clientY - rect.top) * 500 / rect.height); ctx.stroke(); }} onPointerUp={() => drawing.current = false} onPointerCancel={() => drawing.current = false} />
    <footer><button className="ad-button" onClick={clear}>{c.clear}</button><button className="ad-button ad-button-primary" onClick={() => canvas.current?.toBlob(blob => { if (blob) { onAttach(new File([blob], "sketch.png", { type: "image/png" })); onClose(); } })}>{c.sketchAdd}</button></footer>
  </dialog>;
}
