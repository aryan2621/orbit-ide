import { PointerEvent } from "react";

/** Drag handle between panes. Reports the new size computed from the drag distance. */
export default function Resizer({
  direction,
  size,
  onResize,
  invert = false,
}: {
  direction: "horizontal" | "vertical";
  size: number;
  onResize: (size: number) => void;
  /** For panes that grow when dragging toward the top/left (e.g. the bottom panel). */
  invert?: boolean;
}) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const start = direction === "horizontal" ? e.clientX : e.clientY;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    document.body.classList.add(direction === "horizontal" ? "resizing-x" : "resizing-y");
    const move = (ev: globalThis.PointerEvent) => {
      const delta = (direction === "horizontal" ? ev.clientX : ev.clientY) - start;
      onResize(size + (invert ? -delta : delta));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x", "resizing-y");
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return <div className={`resizer resizer-${direction}`} onPointerDown={onPointerDown} role="separator" />;
}
