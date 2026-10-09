import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { SearchIcon } from "lucide-react";
import { InputGroup, InputGroupInput, InputGroupAddon } from "./input-group";
import { Kbd } from "./kbd";
type Props = ComponentProps<"input"> & { icon?: ReactNode; shortcut?: boolean; groupClassName?: string };
export default function KbdInputGroup({ icon, shortcut = false, groupClassName, ...props }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!shortcut) return;
    const focus = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); ref.current?.focus(); } };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, [shortcut]);
  return <InputGroup className={groupClassName}>
    <InputGroupInput ref={ref} {...props} />
    {(icon || props.type === "search") && <InputGroupAddon aria-hidden="true">{icon ?? <SearchIcon />}</InputGroupAddon>}
    {shortcut && <InputGroupAddon align="inline-end" aria-hidden="true"><Kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"}</Kbd><Kbd>K</Kbd></InputGroupAddon>}
  </InputGroup>;
}
