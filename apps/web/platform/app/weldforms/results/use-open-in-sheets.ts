/**
 * "Open in WeldSheets": a new workbook with a connected `form_responses` table
 * for this form (ADR SHEETS-007), then straight to it. The workbook is created
 * first (named after the form), the table is connected on a new tab of it
 * (named like the object, "Form responses"); the connect call writes the first
 * refresh, so the workbook opens with the responses in it. If connecting
 * fails the empty workbook stays and the member sees the error toast.
 */

import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { SHEET_DATA_OBJECTS } from '@weldsuite/app-api-client/schemas/sheet-data';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { defaultFormResponseColumns } from '../lib/sheet-columns';

/** Rows a new responses table lists, the same default as every connected table. */
const LIMIT = 1000;

export function useOpenInSheets(form: FormDetail): { available: boolean; pending: boolean; open: () => void } {
  const installed = useIsAppInstalled('weldsheets');
  const canCreate = useCan('sheets:create');
  const canRead = useCan(SHEET_DATA_OBJECTS.form_responses.permission);
  const { sheets } = useAppApi();
  const navigate = useNavigate();
  const { t } = useI18n();

  const mutation = useMutation({
    mutationFn: async () => {
      const objectName = t.sheetData.objects.form_responses;
      const fieldLabels = t.sheetData.fields.form_responses as Record<string, string>;
      const { columns, headers } = defaultFormResponseColumns(form.definition, (key) => fieldLabels[key] ?? key);
      const sheet = (await sheets.create({ name: form.title.trim().slice(0, 255) || objectName })).data;
      await sheets.createDataSource(sheet.id, {
        objectType: 'form_responses',
        definition: { formId: form.id, columns, headers, filters: [], limit: LIMIT },
        refresh: 'manual',
        target: { newTab: objectName },
      });
      return sheet.id;
    },
    onSuccess: (sheetId) => {
      navigate({ to: '/weldsheets/$sheetId', params: { sheetId } }).catch(() => undefined);
    },
    onError: () => toast.error(t.weldformsResults.results.openInSheetsFailed),
  });

  return {
    available: installed && canCreate && canRead && form.permissions.readResponses,
    pending: mutation.isPending,
    open: () => mutation.mutate(),
  };
}
