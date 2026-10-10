import { Children, isValidElement, useState, useCallback, type ComponentProps, type ReactNode } from "react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./select";
type Props = { value: string; onValueChange(value: string): void; children: ReactNode; disabled?: boolean; required?: boolean; className?: string; "aria-label"?: string; name?: string };
// Accept the existing option trees without introducing sample data or changing state ownership.
export function DataSelect({ value, onValueChange, children, disabled, required, className, name, "aria-label": label }: Props) {
  // Native modal dialogs make body-level portals inert, regardless of z-index.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useCallback((node: HTMLButtonElement | null) => {
    if (node) setContainer(node.closest("dialog"));
  }, []);
  const options = Children.toArray(children).filter(isValidElement<ComponentProps<"option">>);
  const placeholder = options.find(option => option.props.value === "")?.props.children;
  return <Select value={value} onValueChange={onValueChange} disabled={disabled} required={required} name={name}>
    <SelectTrigger ref={triggerRef} className={className} aria-label={label}><SelectValue placeholder={placeholder} /></SelectTrigger>
    <SelectContent container={container}><SelectGroup>{options.filter(option => option.props.value !== "").map(option => <SelectItem key={String(option.props.value)} value={String(option.props.value)} disabled={option.props.disabled}>{option.props.children}</SelectItem>)}</SelectGroup>{options.length <= 1 && <div className="px-3 py-3 text-sm text-muted-foreground" role="status">No options</div>}</SelectContent>
  </Select>;
}
