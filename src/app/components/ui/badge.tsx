import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "./utils";
import { 
  getStatusBadgeClass, 
  STATUS_STYLES, 
  BUSINESS_STATUS_MAP, 
  formatBadgeText,
  type StatusSemantic 
} from "./status-config";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border h-5 px-2 py-0 text-[11px] leading-none font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-status-neutral-border bg-status-neutral-bg text-status-neutral-fg",
        neutral:
          "border-status-neutral-border bg-status-neutral-bg text-status-neutral-fg",
        primary:
          "border-primary-subtle-border bg-primary-subtle text-primary-subtle-foreground",
        success:
          "border-status-success-border bg-status-success-bg text-status-success-fg",
        warning:
          "border-status-warning-border bg-status-warning-bg text-status-warning-fg",
        danger:
          "border-status-danger-border bg-status-danger-bg text-status-danger-fg",
        info:
          "border-status-info-border bg-status-info-bg text-status-info-fg",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-status-error-border bg-status-error-bg text-status-error-fg",
        outline:
          "border-border bg-transparent text-foreground [a&]:hover:bg-accent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
  status?: string | number;
}

function formatBadgeChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") {
    return formatBadgeText(children);
  }
  if (Array.isArray(children)) {
    return React.Children.map(children, (child) => formatBadgeChildren(child));
  }
  if (React.isValidElement(children)) {
    const childProps = children.props as any;
    if (childProps && childProps.children) {
      return React.cloneElement(children as React.ReactElement<any>, {
        ...childProps,
        children: formatBadgeChildren(childProps.children),
      });
    }
  }
  return children;
}

function Badge({
  className,
  variant,
  status,
  asChild = false,
  children,
  ...props
}: BadgeProps) {
  const Comp = asChild ? Slot : "span";
  const isStatusBadge = status !== undefined && status !== null;
  const statusClass = isStatusBadge ? getStatusBadgeClass(status) : "";
  const resolvedVariant = isStatusBadge && !variant ? null : variant;

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant: resolvedVariant }), statusClass, className)}
      {...props}
    >
      {asChild ? children : formatBadgeChildren(children)}
    </Comp>
  );
}

export { Badge, badgeVariants, getStatusBadgeClass, STATUS_STYLES, BUSINESS_STATUS_MAP, formatBadgeText };
export type { StatusSemantic };
