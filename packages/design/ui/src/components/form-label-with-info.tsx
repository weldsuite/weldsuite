import * as React from 'react';
import { Label } from '@weldsuite/ui/components/label';
import { InfoTooltip } from '@weldsuite/ui/components/info-tooltip';
import { InfoPopover } from '@weldsuite/ui/components/info-popover';

export interface FormLabelWithInfoProps extends React.ComponentPropsWithoutRef<typeof Label> {
  /**
   * The label text
   */
  children: React.ReactNode;

  /**
   * Whether the field is required (shows asterisk)
   */
  required?: boolean;

  /**
   * Optional tooltip text to display next to the label.
   * Shows a small info icon with hover tooltip.
   */
  infoTooltip?: string | React.ReactNode;

  /**
   * Optional popover content to display next to the label.
   * Shows a clickable info icon with detailed popover.
   */
  infoPopover?: {
    title?: string | React.ReactNode;
    content: React.ReactNode;
  };
}

/**
 * FormLabelWithInfo - Enhanced label with optional info tooltip or popover.
 * Useful for React Hook Form patterns where you need just an enhanced label.
 *
 * @example
 * <FormLabelWithInfo required infoTooltip="Format: 1000-9999">
 *   Account Number
 * </FormLabelWithInfo>
 */
export function FormLabelWithInfo({
  children,
  required,
  infoTooltip,
  infoPopover,
  ...labelProps
}: FormLabelWithInfoProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Label {...labelProps}>
        {children}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {infoTooltip && <InfoTooltip content={infoTooltip} />}
      {infoPopover && <InfoPopover title={infoPopover.title}>{infoPopover.content}</InfoPopover>}
    </div>
  );
}
