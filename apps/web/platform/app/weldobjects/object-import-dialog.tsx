import { useCallback, useMemo } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  ImportEntitiesDialog,
  type ImportEntitiesResult,
} from '@/components/import/import-entities-dialog';
import { customFieldsToImportFields } from '@/components/custom-fields/to-import-fields';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';
import {
  useImportCustomObjectRecords,
  type CustomObject,
} from '@/hooks/queries/use-custom-objects-queries';

/** Records per import call; smaller than the endpoint's 200 so the progress bar moves. */
const BATCH_SIZE = 50;

/**
 * A select value as the field stores it: a cell may hold the option's label
 * ("In use") or its value (`in_use`), in any case. Unknown text is sent as it
 * is, and the server reports it as an invalid option for that row.
 */
function optionValue(field: CustomFieldDefinition, raw: unknown): unknown {
  const options = field.options ?? [];
  const match = (text: unknown) => {
    const needle = String(text).trim().toLowerCase();
    const option = options.find(
      (o) => o.value.toLowerCase() === needle || o.label.trim().toLowerCase() === needle,
    );
    return option ? option.value : text;
  };
  if (field.fieldType === 'single_select') return match(raw);
  if (field.fieldType === 'multi_select' && Array.isArray(raw)) return raw.map(match);
  return raw;
}

interface ObjectImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  object: CustomObject;
  fields: CustomFieldDefinition[];
}

/** The shared import wizard, for any custom object's records (`POST /objects/:slug/records/import`). */
export function ObjectImportDialog({ open, onOpenChange, object, fields }: Readonly<ObjectImportDialogProps>) {
  const t = useTranslations();
  const importRecords = useImportCustomObjectRecords(object.slug);
  const importFields = useMemo(
    () => customFieldsToImportFields(fields).map((field) => ({ ...field, aliases: [field.customFieldSlug ?? ''] })),
    [fields],
  );
  const fieldBySlug = useMemo(() => new Map(fields.map((field) => [field.slug, field])), [fields]);
  // A row needs a value in a required field (the server checks the rest), or
  // in any field when none is required.
  const required = fields.filter((field) => field.required && field.fieldType !== 'file');
  const requireOneOf = (required.length > 0 ? required : fields).map((field) => `cf:${field.slug}`);

  const onImportBatch = useCallback(
    async (records: Record<string, unknown>[]): Promise<ImportEntitiesResult> => {
      const rows = records.map((record) => {
        const values = (record.customFields as Record<string, unknown> | undefined) ?? {};
        const out: Record<string, unknown> = {};
        for (const [slug, value] of Object.entries(values)) {
          const field = fieldBySlug.get(slug);
          out[slug] = field ? optionValue(field, value) : value;
        }
        return { fields: out };
      });
      const result = await importRecords.mutateAsync(rows);
      return {
        imported: result.created,
        updated: 0,
        failed: result.errors.length,
        total: rows.length,
        errors: result.errors.map((e) => ({ row: e.row, ref: '', error: e.message })),
      };
    },
    [fieldBySlug, importRecords],
  );

  return (
    <ImportEntitiesDialog
      open={open}
      onOpenChange={onOpenChange}
      entityLabel={object.labelPlural.toLowerCase()}
      fields={importFields}
      requireOneOf={requireOneOf}
      templateName={object.slug}
      tips={[t('common.import.tipMatch'), t('common.import.tipNewRecords'), t('common.import.tipTemplate')]}
      showUpdated={false}
      batchSize={BATCH_SIZE}
      onImportBatch={onImportBatch}
    />
  );
}
