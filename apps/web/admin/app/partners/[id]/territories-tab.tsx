'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { savePartnerTerritories } from '@/actions/partners';
import { TerritoryPicker } from '@/components/partners/territory-picker';
import { useSubmit } from '@/components/partners/use-submit';
import { fill } from '@/lib/i18n';
import { countryName, diffTerritories, normalizeCountries, territoryConflictCountries } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerTabProps } from './partner-detail';

const label = (codes: string[]) => codes.map((c) => `${countryName(c)} (${c})`).join(', ');

export function TerritoriesTab({ detail, canWrite }: Readonly<PartnerTabProps>) {
  const t = partnersCopy();
  const router = useRouter();
  const { submit, isPending } = useSubmit();
  const saved = normalizeCountries(detail.territories);
  const [selected, setSelected] = useState<string[]>(saved);
  const [conflict, setConflict] = useState<string | null>(null);

  const diff = diffTerritories(saved, selected);
  const dirty = diff.added.length > 0 || diff.removed.length > 0;

  const onSave = () => {
    setConflict(null);
    submit((requestId) => savePartnerTerritories(detail.partner.id, selected, requestId), {
      success: t.territories.saved,
      onSuccess: () => router.refresh(),
      onFailure: (failure) => {
        if (failure.code !== 'TERRITORY_CONFLICT') return false;
        const countries = territoryConflictCountries(failure.details);
        // Without the list, fall back to the worker's own message.
        setConflict(countries.length > 0 ? fill(t.territories.conflict, { countries: label(countries) }) : failure.error);
        return true;
      },
    });
  };

  return (
    <Card className="py-4">
      <CardContent className="space-y-4 px-4">
        <div>
          <h2 className="text-sm font-medium">{t.territories.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t.territories.description}</p>
        </div>

        <TerritoryPicker value={selected} onChange={setSelected} disabled={!canWrite || isPending} id="partner-territories" />

        {conflict && (
          <Alert variant="destructive">
            <AlertTitle>{t.territories.conflictTitle}</AlertTitle>
            <AlertDescription>{conflict}</AlertDescription>
          </Alert>
        )}

        {dirty && (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t.territories.unsaved}</p>
            {diff.added.length > 0 && <p>{fill(t.territories.willAdd, { countries: label(diff.added) })}</p>}
            {diff.removed.length > 0 && <p>{fill(t.territories.willRemove, { countries: label(diff.removed) })}</p>}
          </div>
        )}

        {canWrite ? (
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button variant="ghost" disabled={isPending} onClick={() => setSelected(saved)}>
                {t.common.cancel}
              </Button>
            )}
            <Button disabled={isPending || !dirty} onClick={onSave}>
              {isPending ? t.common.saving : t.common.save}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t.common.readOnlyNote}</p>
        )}
      </CardContent>
    </Card>
  );
}
