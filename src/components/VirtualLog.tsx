import { ReactNode, useLayoutEffect, useRef, useState } from "react";

const OVERSCAN = 20;

/** A log view that renders only the rows in sight (fixed row height, no wrapping) and follows the
 * end while scrolled to the bottom. Keeps 5,000-line build logs and chatty Logcat smooth. */
export default function VirtualLog<T>({
  items,
  render,
  rowHeight = 19,
  className = "build-log",
  footer,
}: {
  items: T[];
  render: (item: T, index: number) => ReactNode;
  rowHeight?: number;
  className?: string;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [view, setView] = useState({ top: 0, height: 600 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (stick.current && el) {
      el.scrollTop = el.scrollHeight;
      setView({ top: el.scrollTop, height: el.clientHeight });
    }
  }, [items]);

  const onScroll = () => {
    const el = ref.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setView({ top: el.scrollTop, height: el.clientHeight });
  };

  const start = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN);
  return (
    <div className={`${className} vlog`} ref={ref} onScroll={onScroll}>
      <div style={{ height: start * rowHeight }} />
      {items.slice(start, end).map((item, i) => (
        <div key={start + i} className="vlog-row" style={{ height: rowHeight }}>
          {render(item, start + i)}
        </div>
      ))}
      <div style={{ height: (items.length - end) * rowHeight }} />
      {footer}
    </div>
  );
}
