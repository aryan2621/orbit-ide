import { InputHTMLAttributes, forwardRef } from "react";
import { IconClose, IconSearch } from "./Icons";

/** A search box: magnifier, the input, and a clear button once there's text. Esc clears it first. */
const SearchField = forwardRef<
  HTMLInputElement,
  { value: string; onValueChange: (value: string) => void; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">
>(function SearchField({ value, onValueChange, className, onKeyDown, ...rest }, ref) {
  return (
    <div className={`search-field${className ? ` ${className}` : ""}`}>
      <IconSearch />
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
    </div>
  );
});

export default SearchField;
