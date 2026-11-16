import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "./utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium cursor-pointer transition-[background-color,border-color,color,box-shadow,opacity] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/40 focus-visible:ring-[2px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive select-none",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover active:opacity-95",
        primary:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary-hover active:opacity-95",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive-hover active:opacity-95 focus-visible:ring-destructive/30 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-input bg-card hover:bg-muted/70 active:bg-muted text-foreground shadow-xs",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 active:bg-secondary/90 shadow-xs",
        ghost:
          "hover:bg-muted/70 active:bg-muted text-muted-foreground hover:text-foreground",
        link: "text-primary underline-offset-4 hover:text-primary-hover hover:underline shadow-none",
      },
      size: {
        default: "h-9 px-3.5 py-2 has-[>svg]:px-3 rounded-lg",
        sm: "h-8 rounded-md gap-1.5 px-2.5 has-[>svg]:px-2 text-xs",
        lg: "h-10 rounded-lg px-5 has-[>svg]:px-4",
        icon: "size-9 rounded-lg",
        "icon-sm": "size-8 rounded-md [&_svg]:size-3.5",
        "icon-lg": "size-10 rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const isDisabled = Boolean(disabled || loading);

    return (
      <Comp
        data-slot="button"
        data-loading={loading ? "true" : undefined}
        aria-busy={loading || undefined}
        disabled={asChild ? disabled : isDisabled}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      >
        {!asChild && loading && (
          <Loader2 className="animate-spin" aria-hidden="true" />
        )}
        {children}
      </Comp>
    );
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };
