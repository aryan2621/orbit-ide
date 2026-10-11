import { useToasts } from "../state/toasts";
import { IconClose } from "../components/Icons";

export default function Toasts() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span className="grow">{t.message}</span>
          <button className="icon-btn small" title="Dismiss" onClick={() => dismiss(t.id)}>
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  );
}
