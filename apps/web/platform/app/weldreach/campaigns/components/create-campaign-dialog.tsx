/** "New campaign": asks for a name, creates the draft and opens it. */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  createReachCampaignSchema,
  type CreateReachCampaignInput,
} from '@weldsuite/app-api-client/schemas/reach';
import { useCreateReachCampaign } from '@/hooks/queries/use-reach-campaign-queries';
import { ErrorBanner, errorMessage } from '@/app/weldreach/components/engage/kit';

export function CreateCampaignDialog({
  onClose,
  onCreated,
}: Readonly<{ onClose: () => void; onCreated: (campaignId: string) => void }>) {
  const t = useTranslations();
  const create = useCreateReachCampaign();
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<CreateReachCampaignInput>({
    resolver: zodResolver(createReachCampaignSchema),
    defaultValues: { name: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      const res = await create.mutateAsync({ name: values.name });
      onCreated(res.data.id);
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.campaigns.create.failed')));
    }
  });

  const nameError = form.formState.errors.name;

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('reachEngage.campaigns.create.title')}</DialogTitle>
          <DialogDescription>{t('reachEngage.campaigns.create.description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="reach-campaign-name">{t('reachEngage.campaigns.create.name')}</Label>
            <Input
              id="reach-campaign-name"
              autoFocus
              autoComplete="off"
              placeholder={t('reachEngage.campaigns.create.namePlaceholder')}
              aria-invalid={Boolean(nameError)}
              {...form.register('name')}
            />
            {nameError && (
              <p className="text-xs text-destructive">{t('reachEngage.campaigns.create.nameRequired')}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
              {t('reachEngage.common.cancel')}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('reachEngage.campaigns.create.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
