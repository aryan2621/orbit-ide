import { InputHTMLAttributes, ReactNode, forwardRef } from "react";
import { IconClose, IconSearch } from "./Icons";

/** A search box: magnifier, the input, and a clear button once there's text. Esc clears it first. */
const SearchField = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onValueChange: (value: string) => void;
    className?: string;
    /** Leading icon; null for none (e.g. a replace or filter field). */
    icon?: ReactNode | null;
    /** Controls after the input, such as match-case / regex toggles. */
    trailing?: ReactNode;
  } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">
>(function SearchField({ value, onValueChange, className, icon = <IconSearch />, trailing, onKeyDown, ...rest }, ref) {
  return (
    <div className={`search-field${icon === null ? " no-icon" : ""}${className ? ` ${className}` : ""}`}>
      {icon}
      <input
        ref={ref}
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            onValueChange("");
          }
          onKeyDown?.(e);
        }}
        {...rest}
      />
      {value && (
        <button type="button" className="search-field-clear" title="Clear (Esc)" onClick={() => onValueChange("")}>
          <IconClose />
        </button>
      )}
      {trailing}
    </div>
  );
});

export default SearchField;
