/** Live preview of the selected step, rendered by the API for one prospect. */

import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { useDebounce } from '@/hooks/use-debounce';
import { useReachStepPreview } from '@/hooks/queries/use-reach-campaign-queries';
import type { ReachRenderedPreview } from '@weldsuite/app-api-client/schemas/reach';
import { personName } from '@/app/weldreach/components/engage/format';
import { Notice, SectionCard } from '@/app/weldreach/components/engage/kit';

const SAMPLE_VALUE = '__sample__';
const DEBOUNCE_MS = 500;

export interface PreviewProspect {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

function PreviewBody({
  isEmpty,
  failed,
  rendered,
}: Readonly<{
  isEmpty: boolean;
  failed: boolean;
  rendered: ReachRenderedPreview | undefined;
}>) {
  const t = useTranslations();

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
        <Eye className="h-5 w-5" />
        {t('reachEngage.preview.empty')}
      </div>
    );
  }
  if (failed) return <Notice tone="warning">{t('reachEngage.preview.failed')}</Notice>;

  return (
    <>
      {rendered && rendered.missingVariables.length > 0 && (
        <Notice tone="warning" title={t('reachEngage.preview.missingTitle')}>
          <p>
            {t('reachEngage.preview.missingDescription', {
              names: rendered.missingVariables.map((name) => `{{${name}}}`).join(', '),
            })}
          </p>
        </Notice>
      )}

      <div className="space-y-3 rounded-md border bg-muted/20 p-4">
        <div>
          <p className="text-xs text-muted-foreground">{t('reachEngage.preview.subject')}</p>
          <p className="break-words text-sm font-medium">{rendered ? rendered.subject : '…'}</p>
        </div>
        <div className="border-t pt-3">
          <p className="whitespace-pre-wrap break-words text-sm">{rendered ? rendered.body : '…'}</p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t('reachEngage.preview.footerNote')}</p>
    </>
  );
}

export function PreviewPane({
  campaignId,
  stepNumber,
  subject,
  body,
  prospects,
}: Readonly<{
  campaignId: string;
  stepNumber: number;
  subject: string;
  body: string;
  prospects: PreviewProspect[];
}>) {
  const t = useTranslations();
  const [prospectId, setProspectId] = useState<string | undefined>(undefined);

  const debouncedSubject = useDebounce(subject, DEBOUNCE_MS);
  const debouncedBody = useDebounce(body, DEBOUNCE_MS);
  const preview = useReachStepPreview(campaignId, {
    subject: debouncedSubject,
    body: debouncedBody,
    prospectId,
  });

  const rendered = preview.data;
  const isEmpty = subject.trim() === '' && body.trim() === '';

  return (
    <SectionCard
      title={t('reachEngage.preview.title', { number: stepNumber })}
      action={
        preview.isFetching && !isEmpty ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : undefined
      }
      contentClassName="space-y-4"
    >
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground" id="reach-preview-prospect-label">
          {t('reachEngage.preview.prospect')}
        </p>
        <Select
          value={prospectId ?? SAMPLE_VALUE}
          onValueChange={(value) => setProspectId(value === SAMPLE_VALUE ? undefined : value)}
        >
          <SelectTrigger size="sm" aria-labelledby="reach-preview-prospect-label" className="w-full shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SAMPLE_VALUE}>{t('reachEngage.preview.sample')}</SelectItem>
            {prospects.map((prospect) => (
              <SelectItem key={prospect.id} value={prospect.id}>
                {personName(prospect) ?? prospect.email}
                {prospect.companyName ? ` · ${prospect.companyName}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <PreviewBody isEmpty={isEmpty} failed={preview.isError && !rendered} rendered={rendered} />
    </SectionCard>
  );
}
