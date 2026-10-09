import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Separator } from "./separator";
export const buttonGroupVariants = cva("flex w-fit items-stretch [&>*]:focus-visible:relative [&>*]:focus-visible:z-10", { variants: { orientation: { horizontal: "[&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none", vertical: "flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:first-child)]:border-t-0 [&>*:not(:last-child)]:rounded-b-none" } }, defaultVariants: { orientation: "horizontal" } });
export function ButtonGroup({ className, orientation = "horizontal", ...props }: ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) { return <div role="group" data-slot="button-group" data-orientation={orientation} className={cn(buttonGroupVariants({ orientation }), className)} {...props} />; }
export function ButtonGroupText({ className, asChild, ...props }: ComponentProps<"div"> & { asChild?: boolean }) { const Comp = asChild ? Slot : "div"; return <Comp className={cn("flex items-center gap-2 border border-input bg-muted px-4 text-sm", className)} {...props} />; }
export function ButtonGroupSeparator({ className, orientation = "vertical", ...props }: ComponentProps<typeof Separator>) { return <Separator orientation={orientation} className={cn("relative m-0 self-stretch data-[orientation=vertical]:h-auto", className)} {...props} />; }
