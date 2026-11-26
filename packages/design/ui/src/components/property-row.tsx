import * as React from "react";

import { cn } from "../lib/utils";

/**
 * One row of an object panel's details tab, as WeldCRM's company and person
 * panels draw it: the icon and label in a 120px column, the value, and an
 * optional accessory (a copy button, a chevron) on the right.
 *
 * Presentational and free of translations. The platform's editable
 * `PropertyRow` puts its inline editor in the value cell; a read-only caller
 * passes a `PropertyValue`.
 */
export interface PropertyRowLayoutProps {
  icon: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  /** The value cell, usually a `PropertyValue`. */
  children: React.ReactNode;
  /** Rendered on the far right of the row. */
  accessory?: React.ReactNode;
  className?: string;
}

export function PropertyRowLayout({
  icon: Icon,
  label,
  children,
  accessory,
  className,
}: Readonly<PropertyRowLayoutProps>) {
  return (
    <div
      data-slot="property-row"
      className={cn(
        "grid grid-cols-[120px_minmax(0,1fr)_auto] gap-2 items-center group/row min-h-[32px]",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      {children}
      <div className="text-muted-foreground">{accessory}</div>
    </div>
  );
}

/**
 * The value cell's box, shared with the platform's inline editor so a value
 * sits in the same place whether it is being edited or not. `min-w-0` lets it
 * shrink; the text inside wraps itself (`PropertyValue` does).
 */
export const PROPERTY_VALUE_CLASS =
  "text-sm min-w-0 flex items-center min-h-[32px] py-1 rounded-[9px] -mx-2 px-[7px] box-border border border-transparent";

/**
 * A read-only value cell. A long URL or email wraps instead of stretching the
 * row; `tabular` sets figures (dates, codes) in tabular numerals.
 */
export function PropertyValue({
  tabular,
  className,
  children,
}: Readonly<{ tabular?: boolean; className?: string; children: React.ReactNode }>) {
  return (
    <div className={cn(PROPERTY_VALUE_CLASS, tabular && "tabular-nums", className)}>
      <span className="min-w-0 text-foreground break-words [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}
