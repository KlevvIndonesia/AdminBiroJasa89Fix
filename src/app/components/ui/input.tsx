import * as React from "react";

import { cn } from "./utils";

export interface InputProps extends React.ComponentProps<"input"> {
  inputSize?: "sm" | "default" | "lg";
  error?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const inputSizeClasses: Record<NonNullable<InputProps["inputSize"]>, string> = {
  sm: "h-8 px-2.5 text-xs rounded-md",
  default: "h-9 px-3 text-sm rounded-lg",
  lg: "h-10 px-3.5 text-sm rounded-lg",
};

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type,
      onWheel,
      inputSize = "default",
      error,
      leftIcon,
      rightIcon,
      "aria-invalid": ariaInvalid,
      ...props
    },
    ref,
  ) => {
    const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
      if (type === "number") {
        e.currentTarget.blur();
      }
      onWheel?.(e);
    };

    const resolvedInvalid = error ? true : ariaInvalid;

    const inputElement = (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        aria-invalid={resolvedInvalid}
        onWheel={handleWheel}
        className={cn(
          "file:text-foreground placeholder:text-muted-foreground/70 selection:bg-primary selection:text-primary-foreground border-input bg-input-background text-foreground flex w-full min-w-0 border py-1.5 shadow-xs transition-[color,box-shadow,border-color,background-color] outline-none",
          "hover:border-muted-foreground/40",
          "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted/60 disabled:text-muted-foreground disabled:opacity-60",
          "focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-[2px]",
          "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
          inputSizeClasses[inputSize],
          leftIcon && "pl-8",
          rightIcon && "pr-8",
          type === "number" &&
            "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:m-0 [&::-webkit-inner-spin-button]:m-0",
          className,
        )}
        {...props}
      />
    );

    if (leftIcon || rightIcon) {
      return (
        <div className="relative flex w-full items-center">
          {leftIcon && (
            <span className="pointer-events-none absolute left-2.5 flex items-center text-muted-foreground [&_svg]:size-4">
              {leftIcon}
            </span>
          )}
          {inputElement}
          {rightIcon && (
            <span className="pointer-events-none absolute right-2.5 flex items-center text-muted-foreground [&_svg]:size-4">
              {rightIcon}
            </span>
          )}
        </div>
      );
    }

    return inputElement;
  },
);

Input.displayName = "Input";

export { Input };
