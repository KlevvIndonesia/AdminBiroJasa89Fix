import * as React from "react";
import { RotateCcw, Search } from "lucide-react";

import { Button } from "./button";
import { EmptyState, type EmptyStateProps } from "./empty-state";
import { Input } from "./input";
import { TableCell, TableRow } from "./table";
import { cn } from "./utils";

/**
 * Canonical Admin table container shell.
 * Standardizes card borders, surface, radius, overflow clipping, and optional bottom pagination bar.
 */
export interface DataTableShellProps extends React.ComponentProps<"div"> {
  footer?: React.ReactNode;
  footerClassName?: string;
  bodyClassName?: string;
}

export function DataTableShell({
  children,
  footer,
  footerClassName,
  bodyClassName,
  className,
  ...props
}: DataTableShellProps) {
  return (
    <div
      data-slot="data-table-shell"
      className={cn(
        "rounded-lg border border-border bg-card overflow-hidden shadow-xs flex-1 flex flex-col min-h-0",
        className,
      )}
      {...props}
    >
      <div className={cn("w-full flex-1 flex flex-col min-h-0", bodyClassName)}>
        {children}
      </div>
      {footer && (
        <div
          data-slot="data-table-footer"
          className={cn("px-3.5 pb-3 bg-card shrink-0 mt-auto", footerClassName)}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * Canonical Admin table toolbar providing consistent left actions/filters and right search input.
 */
export interface DataTableToolbarProps extends React.ComponentProps<"div"> {
  left?: React.ReactNode;
  right?: React.ReactNode;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  searchClassName?: string;
  showReset?: boolean;
  onReset?: () => void;
  resetLabel?: string;
}

export function DataTableToolbar({
  left,
  right,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Cari data...",
  searchAriaLabel,
  searchClassName,
  showReset,
  onReset,
  resetLabel = "Reset",
  className,
  ...props
}: DataTableToolbarProps) {
  const hasSearchControl = onSearchChange !== undefined && searchValue !== undefined;

  return (
    <div
      data-slot="data-table-toolbar"
      className={cn(
        "flex flex-col md:flex-row gap-2.5 justify-between items-stretch md:items-center shrink-0",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {left}
        {showReset && onReset && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReset}
            className="h-8 px-2.5 text-xs border-border gap-1 text-muted-foreground hover:text-foreground shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{resetLabel}</span>
          </Button>
        )}
      </div>

      {(hasSearchControl || right) && (
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap justify-end">
          {hasSearchControl && (
            <div className={cn("relative w-full sm:w-72 md:w-80", searchClassName)}>
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={searchValue}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchAriaLabel || searchPlaceholder}
                className="pl-8 bg-background border-border h-8 text-xs font-normal placeholder:font-normal placeholder:text-muted-foreground/65"
              />
            </div>
          )}
          {right}
        </div>
      )}
    </div>
  );
}

/**
 * Standardized empty table row wrapping EmptyState with consistent colspan and vertical centering.
 */
export interface DataTableEmptyRowProps {
  colSpan: number;
  icon?: EmptyStateProps["icon"];
  title?: string;
  description?: string;
  action?: React.ReactNode;
  cellClassName?: string;
  emptyStateClassName?: string;
}

export function DataTableEmptyRow({
  colSpan,
  icon,
  title = "Tidak ada data ditemukan",
  description,
  action,
  cellClassName,
  emptyStateClassName,
}: DataTableEmptyRowProps) {
  return (
    <TableRow className="h-full hover:bg-transparent">
      <TableCell
        colSpan={colSpan}
        className={cn("text-center p-0 align-middle", cellClassName)}
      >
        <EmptyState
          icon={icon}
          title={title}
          description={description}
          action={action}
          className={emptyStateClassName}
        />
      </TableCell>
    </TableRow>
  );
}
