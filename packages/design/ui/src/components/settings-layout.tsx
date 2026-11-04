'use client';

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useUiLabels } from '@weldsuite/ui/providers/ui-labels-provider';
import { cn } from '@weldsuite/ui/lib/utils';

export interface SettingsPageProps {
  title: ReactNode;
  description?: ReactNode;
  /** Enables Save (and Cancel): there are unsaved edits. */
  hasChanges: boolean;
  saving: boolean;
  onSave: () => void;
  /** Shows a Cancel button that discards the edits. */
  onCancel?: () => void;
  /** Defaults to the `save` label of `UiLabelsProvider`. */
  saveLabel?: string;
  /** Defaults to the `cancel` label of `UiLabelsProvider`. */
  cancelLabel?: string;
  children: ReactNode;
}

/**
 * A settings form page: a header with title, description and one Save (enabled
 * while there are changes), then `max-w-2xl` sections built from
 * `SettingsSection` and `SettingRow`.
 */
export function SettingsPage({
  title,
  description,
  hasChanges,
  saving,
  onSave,
  onCancel,
  saveLabel,
  cancelLabel,
  children,
}: Readonly<SettingsPageProps>) {
  const labels = useUiLabels();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button variant="outline" size="sm" onClick={onCancel} disabled={!hasChanges || saving}>
              {cancelLabel ?? labels.cancel}
            </Button>
          )}
          <Button size="sm" onClick={onSave} disabled={!hasChanges || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saveLabel ?? labels.save}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-10 px-4 py-10">{children}</div>
      </div>
    </div>
  );
}

export interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A titled group of settings. */
export function SettingsSection({ title, description, children, className }: Readonly<SettingsSectionProps>) {
  return (
    <section className={cn('space-y-4', className)}>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** The control on the right (Switch, Select…). */
  children: ReactNode;
  className?: string;
}

/** A labelled row with its control on the right. */
export function SettingRow({ label, description, children, className }: Readonly<SettingRowProps>) {
  return (
    <div className={cn('flex items-center justify-between gap-6', className)}>
      <div className="space-y-1">
        <p className="text-sm font-medium">{label}</p>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
