'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import type { CustomFieldDefinition } from '@/hooks/use-custom-fields';
import type { CustomObject } from '@/hooks/queries/use-custom-objects-queries';
import { FieldRow, groupFields } from './field-input';

/**
 * Create/edit form for a custom object record, driven entirely by the object's
 * field definitions. No per-object code — adding a field to an object adds a
 * control here on the next render.
 */
export function RecordFormDialog({
  open,
  onOpenChange,
  object,
  fields,
  initialValues,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  object: CustomObject;
  fields: CustomFieldDefinition[];
  initialValues?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}) {
  const { t: i18n } = useI18n();
  const t = i18n.weldobjects;
  const [values, setValues] = React.useState<Record<string, unknown>>(initialValues ?? {});
  const [submitting, setSubmitting] = React.useState(false);

  // Reset whenever the dialog opens so a cancelled edit doesn't leak its
  // half-typed state into the next one.
  React.useEffect(() => {
    if (open) setValues(initialValues ?? {});
  }, [open, initialValues]);

  const grouped = React.useMemo(() => groupFields(fields), [fields]);
  const isEdit = !!initialValues;

  /**
   * Client-side required check.
   *
   * The server validates too — this is not the security boundary, it just
   * avoids a round-trip to be told about an empty box the user can see.
   */
  function missingRequired(): CustomFieldDefinition | null {
    for (const field of fields) {
      if (!field.required) continue;
      const value = values[field.slug];
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);
      if (empty) return field;
    }
    return null;
  }

  async function handleSubmit() {
    const missing = missingRequired();
    if (missing) {
      toast.error(t.form.requiredField.replace('{field}', missing.name));
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(values);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.errors.saveFailed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {(isEdit ? t.form.editTitle : t.form.createTitle).replace(
              '{object}',
              object.labelSingular,
            )}
          </DialogTitle>
          {object.description ? (
            <DialogDescription>{object.description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="space-y-6 py-2">
          {grouped.map((group) => (
            <div key={group.group ?? '__ungrouped__'} className="space-y-4">
              {group.group ? (
                <h3 className="text-sm font-medium text-muted-foreground">{group.group}</h3>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                {group.fields.map((field) => (
                  <div
                    key={field.id}
                    className={field.fieldType === 'textarea' ? 'sm:col-span-2' : undefined}
                  >
                    <FieldRow
                      field={field}
                      value={values[field.slug]}
                      onChange={(next) =>
                        setValues((prev) => ({ ...prev, [field.slug]: next }))
                      }
                      disabled={submitting}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t.form.cancel}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? t.form.saving : t.form.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
