'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { updatePartnerProfile } from '@/actions/partners';
import { ProfileFields } from '@/components/partners/profile-fields';
import { useSubmit } from '@/components/partners/use-submit';
import { changedProfileFields, parseProfileForm, profileFormFromRecord, type ProfileFormState } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerTabProps } from './partner-detail';

export function ProfileTab({ detail, canWrite }: Readonly<PartnerTabProps>) {
  const t = partnersCopy();
  const router = useRouter();
  const { submit, isPending } = useSubmit();
  const saved = profileFormFromRecord(detail.partner);
  const [form, setForm] = useState<ProfileFormState>(saved);

  const onSave = () => {
    const parsed = parseProfileForm(form);
    if (!parsed.ok) return void toast.error(parsed.error);
    const patch = changedProfileFields(form, saved);
    if (Object.keys(patch).length === 0) return void toast.info(t.profile.noChanges);
    submit((requestId) => updatePartnerProfile(detail.partner.id, patch, requestId), {
      success: t.profile.saved,
      onSuccess: () => router.refresh(),
    });
  };

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <div>
            <h2 className="text-sm font-medium">{t.profile.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t.profile.hint}</p>
          </div>
          <ProfileFields value={form} onChange={setForm} disabled={!canWrite || isPending} idPrefix="profile" />
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <dt>{t.detail.stripeCustomer}</dt>
              <dd className="font-mono">{detail.partner.stripeCustomerId ?? t.detail.noStripeCustomer}</dd>
            </div>
          </dl>
          {canWrite ? (
            <div className="flex justify-end">
              <Button disabled={isPending} onClick={onSave}>
                {isPending ? t.common.saving : t.common.save}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t.common.readOnlyNote}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
