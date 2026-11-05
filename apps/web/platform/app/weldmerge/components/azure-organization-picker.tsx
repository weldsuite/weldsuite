import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { MergeAzureOrganizationOption } from '@weldsuite/app-api-client/schemas/weldmerge-providers';
import { useSetMergeAzureOrganization } from '@/hooks/queries/use-weldmerge-sync-queries';
import { useI18n } from '@/lib/i18n/provider';
import { trimTrailingSlashes } from '../lib/url';

/** `https://dev.azure.com/<org>` → `<org>`; the API takes the organisation name. */
export function azureOrganizationName(option: MergeAzureOrganizationOption): string {
  return option.name || trimTrailingSlashes(option.url).split('/').pop() || option.url;
}

/**
 * Azure DevOps with more than one organisation: the connection exists but has
 * none yet, so the member picks which one it uses.
 */
export function AzureOrganizationPicker({
  connectionId,
  organizations,
  onDone,
}: Readonly<{
  connectionId: string;
  organizations: readonly MergeAzureOrganizationOption[];
  onDone: () => void;
}>) {
  const { t } = useI18n();
  const ta = t.weldmerge.sync.azureOrganization;
  const save = useSetMergeAzureOrganization();
  const [organization, setOrganization] = useState('');

  const submit = async () => {
    try {
      await save.mutateAsync({ connectionId, organization });
      toast.success(ta.saved);
      onDone();
    } catch {
      toast.error(ta.failed);
    }
  };

  return (
    <div className="w-full max-w-sm space-y-4 text-left">
      <div className="space-y-1 text-center">
        <h1 className="text-lg font-semibold">{ta.title}</h1>
        <p className="text-sm text-muted-foreground">{ta.description}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="merge-azure-organization">{ta.label}</Label>
        <Select value={organization} onValueChange={setOrganization}>
          <SelectTrigger id="merge-azure-organization" className="w-full">
            <SelectValue placeholder={ta.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((option) => (
              <SelectItem key={option.url} value={azureOrganizationName(option)}>
                {azureOrganizationName(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button className="w-full" onClick={() => void submit()} disabled={organization === '' || save.isPending}>
        {save.isPending && <Loader2 className="animate-spin" />}
        {save.isPending ? ta.submitting : ta.submit}
      </Button>
    </div>
  );
}
