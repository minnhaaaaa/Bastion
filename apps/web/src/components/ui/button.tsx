import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
export const buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50", {
  variants: { variant: { default: "bg-primary text-primary-foreground", destructive: "bg-destructive text-destructive-foreground", outline: "border border-input bg-background hover:bg-accent", secondary: "bg-secondary text-secondary-foreground", ghost: "hover:bg-accent hover:text-accent-foreground", link: "text-primary underline-offset-4 hover:underline" }, size: { default: "h-11 px-4 py-2", sm: "h-9 px-3", lg: "h-11 px-8", icon: "size-11" } }, defaultVariants: { variant: "default", size: "default" }
});
export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = "Button";
