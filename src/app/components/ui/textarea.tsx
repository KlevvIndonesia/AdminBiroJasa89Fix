import * as React from "react";

import { cn } from "./utils";

export interface TextareaProps extends React.ComponentProps<"textarea"> {
  error?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, "aria-invalid": ariaInvalid, ...props }, ref) => {
    const resolvedInvalid = error ? true : ariaInvalid;

    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        aria-invalid={resolvedInvalid}
        className={cn(
          "flex min-h-16 w-full rounded-lg border border-input bg-input-background px-3 py-2 text-sm text-foreground shadow-xs transition-[color,box-shadow,border-color,background-color] outline-none resize-y",
          "hover:border-muted-foreground/40",
          "placeholder:text-muted-foreground/70",
          "focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-[2px]",
          "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
          "disabled:cursor-not-allowed disabled:bg-muted/60 disabled:text-muted-foreground disabled:opacity-60",
          className,
        )}
        {...props}
      />
    );
  },
);

Textarea.displayName = "Textarea";

export { Textarea };
