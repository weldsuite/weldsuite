/** Save, remove and test one integration of a form; shared by the three kind cards. */

import { toast } from 'sonner';
import type { FormIntegration, FormIntegrationInput, FormIntegrationKind } from '@weldsuite/app-api-client/schemas/weldforms';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCreateFormIntegration,
  useDeleteFormIntegration,
  useTestFormIntegration,
  useUpdateFormIntegration,
} from '@/hooks/queries/use-weldforms-results-queries';
import { errorMessage } from '../results/form-gate';

export function useIntegration(formId: string, integration: FormIntegration | null) {
  const { t, format } = useI18n();
  const ti = t.weldformsResults.integrations;
  const create = useCreateFormIntegration(formId);
  const update = useUpdateFormIntegration(formId);
  const remove = useDeleteFormIntegration(formId);
  const test = useTestFormIntegration(formId);

  async function save(kind: FormIntegrationKind, enabled: boolean, config: Record<string, unknown>): Promise<boolean> {
    try {
      if (integration) {
        await update.mutateAsync({ integrationId: integration.id, patch: { enabled, config } });
      } else {
        await create.mutateAsync({ kind, enabled, config } as FormIntegrationInput);
      }
      toast.success(ti.saved);
      return true;
    } catch (err) {
      toast.error(errorMessage(err, ti.saveFailed));
      return false;
    }
  }

  async function removeIt(): Promise<void> {
    if (!integration) return;
    try {
      await remove.mutateAsync(integration.id);
      toast.success(ti.removed);
    } catch (err) {
      toast.error(errorMessage(err, ti.removeFailed));
    }
  }

  async function runTest(): Promise<void> {
    if (!integration) return;
    try {
      const res = await test.mutateAsync(integration.id);
      if (res.data.ok) toast.success(format(ti.testOk, { message: res.data.message }));
      else toast.error(format(ti.testFailed, { message: res.data.message }));
    } catch (err) {
      toast.error(format(ti.testFailed, { message: errorMessage(err, ti.testNoResponse) }));
    }
  }

  return {
    save,
    remove: removeIt,
    runTest,
    saving: create.isPending || update.isPending,
    removing: remove.isPending,
    testing: test.isPending,
  };
}
