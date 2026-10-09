import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function Field({ className, ...props }: ComponentProps<"div">) { return <div data-slot="field" className={cn("flex w-full flex-col gap-2", className)} {...props} />; }
