import * as React from "react";
import * as Primitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
export const Tooltip = Primitive.Root;
export const TooltipTrigger = Primitive.Trigger;
export const TooltipProvider = Primitive.Provider;
export const TooltipContent = React.forwardRef<React.ElementRef<typeof Primitive.Content>, React.ComponentPropsWithoutRef<typeof Primitive.Content>>(({ className, children, ...props }, ref) => <Primitive.Portal><Primitive.Content ref={ref} className={cn("control-popover z-50 min-w-32 rounded-md border border-input bg-popover p-2 text-popover-foreground outline-none", className)} {...props}>{children}</Primitive.Content></Primitive.Portal>);
TooltipContent.displayName = "TooltipContent";
