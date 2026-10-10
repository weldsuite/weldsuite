'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { createPartner } from '@/actions/partners';
import { Field } from '@/components/billing/action-dialog';
import { ContractFields } from '@/components/partners/contract-fields';
import { ProfileFields } from '@/components/partners/profile-fields';
import { TerritoryPicker } from '@/components/partners/territory-picker';
import { useSubmit } from '@/components/partners/use-submit';
import type { PlanOption } from '@/lib/billing-types';
import { fill } from '@/lib/i18n';
import {
  contractPayload,
  countryName,
  defaultContractForm,
  emptyProfileForm,
  parseContractForm,
  parseProfileForm,
  profilePayload,
  territoryConflictCountries,
} from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';

export function NewPartnerForm({ planOptions }: Readonly<{ planOptions: PlanOption[] }>) {
  const t = partnersCopy();
  const router = useRouter();
  const { submit, isPending } = useSubmit();
  const [profile, setProfile] = useState(emptyProfileForm);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [contract, setContract] = useState(defaultContractForm);
  const [territories, setTerritories] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]);

  const onSubmit = () => {
    const profileResult = parseProfileForm(profile);
    if (!profileResult.ok) return void toast.error(profileResult.error);
    const contractResult = parseContractForm({ ...contract, effectiveFrom: '' });
    if (!contractResult.ok) return void toast.error(contractResult.error);
    if (!/^\S+@\S+\.\S+$/.test(ownerEmail.trim())) return void toast.error(`${t.new.ownerEmail}: invalid email`);

    setConflicts([]);
    submit(
      (requestId) =>
        createPartner(
          {
            profile: profilePayload(profile),
            ownerEmail: ownerEmail.trim(),
            contract: contractPayload({ ...contract, effectiveFrom: '' }),
            territories,
          },
          requestId,
        ),
      {
        success: t.new.created,
        onSuccess: (partner) => router.push(`/partners/${partner.id}`),
        onFailure: (failure) => {
          if (failure.code !== 'TERRITORY_CONFLICT') return false;
          const countries = territoryConflictCountries(failure.details);
          setConflicts(countries);
          toast.error(
            fill(t.new.territoryConflict, {
              countries: countries.length > 0 ? countries.map((c) => `${countryName(c)} (${c})`).join(', ') : failure.error,
            }),
          );
          return true;
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <h2 className="text-sm font-medium">{t.new.profile}</h2>
          <ProfileFields value={profile} onChange={setProfile} disabled={isPending} idPrefix="new-partner" />
        </CardContent>
      </Card>

      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <h2 className="text-sm font-medium">{t.new.owner}</h2>
          <Field label={t.new.ownerEmail} htmlFor="new-partner-owner" hint={t.new.ownerHint}>
            <Input
              id="new-partner-owner"
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              disabled={isPending}
              maxLength={255}
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <h2 className="text-sm font-medium">{t.new.contract}</h2>
          <ContractFields
            value={contract}
            onChange={setContract}
            disabled={isPending}
            planOptions={planOptions}
            idPrefix="new-contract"
            showEffectiveFrom={false}
          />
        </CardContent>
      </Card>

      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <h2 className="text-sm font-medium">{t.new.territories}</h2>
          <p className="text-xs text-muted-foreground">{t.territories.description}</p>
          <TerritoryPicker value={territories} onChange={setTerritories} disabled={isPending} id="new-partner-territories" />
          {conflicts.length > 0 && (
            <Alert variant="destructive">
              <AlertTitle>{t.territories.conflictTitle}</AlertTitle>
              <AlertDescription>
                {fill(t.territories.conflict, { countries: conflicts.map((c) => `${countryName(c)} (${c})`).join(', ') })}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button disabled={isPending} onClick={onSubmit}>
          {isPending ? t.common.working : t.new.submit}
        </Button>
      </div>
    </div>
  );
}
