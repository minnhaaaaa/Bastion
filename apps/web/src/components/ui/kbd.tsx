import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return <kbd data-slot="kbd" className={cn("bg-muted text-muted-foreground pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 font-mono text-xs select-none", className)} {...props} />;
}
export function KbdGroup({ className, ...props }: ComponentProps<"div">) { return <div data-slot="kbd-group" className={cn("inline-flex items-center gap-1", className)} {...props} />; }
