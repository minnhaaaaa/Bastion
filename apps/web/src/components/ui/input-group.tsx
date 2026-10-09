import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";
export function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="input-group" role="group" className={cn("group/input-group relative flex min-h-11 min-w-0 w-full items-center rounded-md border border-input bg-background has-[>textarea]:h-auto has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-end]]:flex-col has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot][aria-invalid=true]]:border-destructive", className)} {...props} />;
}
const addonVariants = cva("text-muted-foreground flex shrink-0 items-center justify-center gap-2 py-1.5 text-sm select-none [&>svg]:block [&>svg]:size-4 [&>svg]:shrink-0", { variants: { align: { "inline-start": "order-first pl-3", "inline-end": "order-last pr-3", "block-start": "order-first w-full justify-start px-3 pt-3", "block-end": "order-last w-full justify-start px-3 pb-3" } }, defaultVariants: { align: "inline-start" } });
export function InputGroupAddon({ className, align = "inline-start", onClick, ...props }: React.ComponentProps<"div"> & VariantProps<typeof addonVariants>) {
  return <div data-slot="input-group-addon" data-align={align} className={cn(addonVariants({ align }), className)} onClick={event => { onClick?.(event); if (!event.defaultPrevented && !(event.target as HTMLElement).closest("button")) event.currentTarget.parentElement?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")?.focus(); }} {...props} />;
}
const sizes = cva("flex items-center gap-2 text-sm shadow-none", { variants: { size: { xs: "h-6 px-2", sm: "h-8 px-2.5", "icon-xs": "size-6 p-0", "icon-sm": "size-8 p-0" } }, defaultVariants: { size: "xs" } });
export function InputGroupButton({ className, type = "button", variant = "ghost", size = "xs", ...props }: Omit<React.ComponentProps<typeof Button>, "size"> & VariantProps<typeof sizes>) { return <Button type={type} variant={variant} className={cn(sizes({ size }), className)} {...props} />; }
export function InputGroupText({ className, ...props }: React.ComponentProps<"span">) { return <span className={cn("text-muted-foreground flex items-center gap-2 text-sm", className)} {...props} />; }
export const InputGroupInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, ...props }, ref) => <Input ref={ref} data-slot="input-group-control" className={cn("min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0", className)} {...props} />);
InputGroupInput.displayName = "InputGroupInput";
export const InputGroupTextarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(({ className, ...props }, ref) => <Textarea ref={ref} data-slot="input-group-control" className={cn("flex-1 resize-none rounded-none border-0 bg-transparent py-3 shadow-none focus-visible:ring-0", className)} {...props} />);
InputGroupTextarea.displayName = "InputGroupTextarea";
