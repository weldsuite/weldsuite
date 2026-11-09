import { Copy, ExternalLink } from 'lucide-react';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { useI18n } from '@/lib/i18n/provider';
import { useCopy } from './use-copy';

export function LinkCard({ form, shareable }: Readonly<{ form: FormDetail; shareable: boolean }>) {
  const { t, format } = useI18n();
  const ts = t.weldformsResults.share.link;
  const copy = useCopy();
  const url = shareable ? form.publicUrl : null;

  let restriction = '';
  if (form.respondentMode === 'verified_email') restriction = ts.restrictionVerified;
  else if (form.respondentMode === 'members') restriction = ts.restrictionMembers;

  return (
    <SectionCard title={ts.title} description={format(ts.description, { restriction })}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          readOnly
          value={url ?? ''}
          placeholder={ts.notAvailable}
          aria-label={ts.label}
          className="min-w-0 flex-1 font-mono text-sm"
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={!url} onClick={() => url && void copy(url, ts.copied)}>
            <Copy className="mr-1.5 h-4 w-4" />
            {ts.copy}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!url}
            onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink className="mr-1.5 h-4 w-4" />
            {ts.open}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
