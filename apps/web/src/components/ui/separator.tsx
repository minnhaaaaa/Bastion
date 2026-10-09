import * as React from "react";
import * as Primitive from "@radix-ui/react-separator";
import { cn } from "@/lib/utils";
export const Separator = React.forwardRef<React.ElementRef<typeof Primitive.Root>, React.ComponentPropsWithoutRef<typeof Primitive.Root>>(({ className, children, ...props }, ref) => <Primitive.Root ref={ref} className={cn("bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px", className)} {...props}>{children}</Primitive.Root>);
Separator.displayName = "Separator";
