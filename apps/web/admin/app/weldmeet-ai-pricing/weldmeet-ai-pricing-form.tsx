'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Video } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { saveWeldmeetAiPricing } from '@/actions/weldmeet-ai-pricing';
import { adminMeetAiPricingCopy, fill } from '@/lib/i18n';
import {
  EXAMPLE_MEETING_MINUTES,
  MAX_CREDITS_PER_MINUTE,
  exampleCharge,
  parsePricingInput,
} from '@/lib/weldmeet-ai-pricing';
import type { WeldmeetAiPricingView } from '@/lib/weldmeet-ai-pricing-data';

/** Fixed UTC format so the server render and the client hydration agree. */
function formatTimestamp(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export function WeldmeetAiPricingForm({ pricing }: Readonly<{ pricing: WeldmeetAiPricingView }>) {
  const router = useRouter();
  const copy = adminMeetAiPricingCopy();
  const [isSaving, startSave] = useTransition();
  const [transcription, setTranscription] = useState(String(pricing.effective.transcriptionCreditsPerMinute));
  const [summary, setSummary] = useState(String(pricing.effective.summaryCreditsPerMinute));

  const parsed = parsePricingInput({
    transcriptionCreditsPerMinute: transcription,
    summaryCreditsPerMinute: summary,
  });
  const example = parsed.ok ? exampleCharge(parsed.data) : null;

  function save() {
    startSave(async () => {
      const result = await saveWeldmeetAiPricing({
        transcriptionCreditsPerMinute: transcription,
        summaryCreditsPerMinute: summary,
      });
      if (result.ok) {
        toast.success(copy.saved);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function resetToDefaults() {
    setTranscription(String(pricing.defaults.transcriptionCreditsPerMinute));
    setSummary(String(pricing.defaults.summaryCreditsPerMinute));
  }

  return (
    <PageContent>
      <PageBody className="space-y-6" width="narrow">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <Video className="h-6 w-6 text-primary" />
              {copy.title}
            </span>
          }
          description={copy.description}
        />

        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">{copy.effectiveHeading}</h2>
            <Badge variant={pricing.isCustom ? 'secondary' : 'outline'}>
              {pricing.isCustom ? copy.sourceCustom : copy.sourceDefault}
            </Badge>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Card className="py-4">
              <CardContent className="px-4">
                <p className="text-xs text-muted-foreground">{copy.transcriptionLabel}</p>
                <p className="mt-1 text-lg font-medium tabular-nums">
                  {pricing.effective.transcriptionCreditsPerMinute}
                </p>
                <p className="text-xs text-muted-foreground">{copy.perMinuteUnit}</p>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent className="px-4">
                <p className="text-xs text-muted-foreground">{copy.summaryLabel}</p>
                <p className="mt-1 text-lg font-medium tabular-nums">
                  {pricing.effective.summaryCreditsPerMinute}
                </p>
                <p className="text-xs text-muted-foreground">{copy.perMinuteUnit}</p>
              </CardContent>
            </Card>
          </div>
          <p className="text-xs text-muted-foreground">
            {pricing.updatedAt
              ? fill(copy.lastUpdated, {
                  at: formatTimestamp(pricing.updatedAt),
                  by: pricing.updatedBy ?? copy.unknownAdmin,
                })
              : copy.neverUpdated}
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium">{copy.editHeading}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="meet-ai-transcription">{copy.transcriptionInputLabel}</Label>
              <Input
                id="meet-ai-transcription"
                type="number"
                inputMode="decimal"
                min="0.01"
                max={MAX_CREDITS_PER_MINUTE}
                step="0.01"
                value={transcription}
                onChange={(e) => setTranscription(e.target.value)}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="meet-ai-summary">{copy.summaryInputLabel}</Label>
              <Input
                id="meet-ai-summary"
                type="number"
                inputMode="decimal"
                min="0.01"
                max={MAX_CREDITS_PER_MINUTE}
                step="0.01"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                disabled={isSaving}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{fill(copy.inputHelp, { max: MAX_CREDITS_PER_MINUTE })}</p>

          <Card className="py-4">
            <CardContent className="px-4">
              <p className="text-xs font-medium text-muted-foreground">{copy.exampleHeading}</p>
              <p className="mt-1 text-sm">
                {example
                  ? fill(copy.exampleLine, {
                      minutes: EXAMPLE_MEETING_MINUTES,
                      transcription: example.transcription,
                      summary: example.summary,
                      total: example.total,
                    })
                  : copy.exampleInvalid}
              </p>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">{copy.cacheNote}</p>
          <p className="text-xs text-muted-foreground">
            {fill(copy.defaultsNote, {
              transcription: pricing.defaults.transcriptionCreditsPerMinute,
              summary: pricing.defaults.summaryCreditsPerMinute,
            })}
          </p>

          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {copy.saveButton}
            </Button>
            <Button variant="outline" onClick={resetToDefaults} disabled={isSaving}>
              {copy.resetButton}
            </Button>
          </div>
        </section>
      </PageBody>
    </PageContent>
  );
}
