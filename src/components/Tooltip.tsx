import { useEffect, useLayoutEffect, useRef, useState } from "react";

const DELAY_MS = 450;
const TARGETS = 'button, select, a[href], [role="button"], [role="tab"], .tab';

/** The tooltip for an element: its title (or, for icon-only controls, its aria-label), and only when
 * that says more than the visible label. Plain text buttons get none. */
function tipFor(el: HTMLElement): string {
  // Move `title` into data-tip so the browser's own (unstyled, slow) tooltip doesn't also appear.
  const title = el.getAttribute("title");
  if (title) {
    el.dataset.tip = title;
    el.removeAttribute("title");
    if (!el.getAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", title);
  }
  const visible = el.tagName === "SELECT" ? "" : (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const tip = el.dataset.tip || (!visible ? el.getAttribute("aria-label") : "") || "";
  const same = (a: string, b: string) => a.toLowerCase().replace(/[…:.]/g, "").trim() === b.toLowerCase().replace(/[…:.]/g, "").trim();
  if (!tip || (visible && same(tip, visible))) return "";
  return tip.length > 160 ? tip.slice(0, 157) + "…" : tip;
}

/** One styled tooltip for buttons that need explaining (icons, toggles, extra detail). Mount once at the app root. */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(TARGETS) as HTMLElement | null;
      if (el === current) return;
      hide();
      // Monaco and the terminal have their own hovers.
      if (!el || el.closest(".monaco-editor, .xterm, .tooltip")) return;
      const text = tipFor(el);
      if (!text) return;
      current = el;
      timer = setTimeout(() => {
        if (current === el && el.isConnected) setTip({ text, rect: el.getBoundingClientRect() });
      }, DELAY_MS);
    };
    const out = (e: PointerEvent) => {
      if (current && !current.contains(e.relatedTarget as Node | null)) hide();
    };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    for (const ev of ["pointerdown", "keydown", "wheel", "blur"]) window.addEventListener(ev, hide, true);
    return () => {
      hide();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      for (const ev of ["pointerdown", "keydown", "wheel", "blur"]) window.removeEventListener(ev, hide, true);
    };
  }, []);

  // Below the element, centred; above it when there's no room; kept inside the window.
  useLayoutEffect(() => {
    if (!tip || !box.current) return setPos(null);
    const { width, height } = box.current.getBoundingClientRect();
    const r = tip.rect;
    let top = r.bottom + 6;
    if (top + height > window.innerHeight - 4) top = r.top - height - 6;
    const left = Math.min(Math.max(4, r.left + r.width / 2 - width / 2), window.innerWidth - width - 4);
    setPos({ left, top: Math.max(4, top) });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} className="tooltip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden", left: 0, top: 0 }}>
      {tip.text}
    </div>
  );
}
