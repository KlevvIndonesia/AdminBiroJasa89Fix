import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";

const alertVariants = cva(
  "relative w-full rounded-xl border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current shadow-xs",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground border-border",
        destructive:
          "text-status-danger-fg bg-status-danger-bg border-status-danger-border [&>svg]:text-status-danger-fg *:data-[slot=alert-description]:text-status-danger-fg/90",
        warning:
          "text-status-warning-fg bg-status-warning-bg border-status-warning-border [&>svg]:text-status-warning-fg *:data-[slot=alert-description]:text-status-warning-fg/90",
        info:
          "text-status-info-fg bg-status-info-bg border-status-info-border [&>svg]:text-status-info-fg *:data-[slot=alert-description]:text-status-info-fg/90",
        success:
          "text-status-success-fg bg-status-success-bg border-status-success-border [&>svg]:text-status-success-fg *:data-[slot=alert-description]:text-status-success-fg/90",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
