'use client';

import { useState, useTransition } from 'react';
import { useRouter } from '@/lib/navigation';
import { Activity, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { saveWeldpanelPricing } from '@/actions/weldpanel-pricing';
import { adminPanelPricingCopy, fill } from '@/lib/i18n';
import {
  EXAMPLE_EVENTS,
  EXAMPLE_RECORDINGS,
  MAX_CREDITS_PER_BLOCK,
  exampleCharge,
  parsePricingInput,
} from '@/lib/weldpanel-pricing';
import type { WeldpanelPricingView } from '@/lib/weldpanel-pricing-data';

/** Fixed UTC format so the server render and the client hydration agree. */
function formatTimestamp(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export function WeldpanelPricingForm({ pricing }: Readonly<{ pricing: WeldpanelPricingView }>) {
  const router = useRouter();
  const copy = adminPanelPricingCopy();
  const [isSaving, startSave] = useTransition();
  const [events, setEvents] = useState(String(pricing.effective.eventsCreditsPer10k));
  const [recordings, setRecordings] = useState(String(pricing.effective.recordingsCreditsPer100));

  const parsed = parsePricingInput({ eventsCreditsPer10k: events, recordingsCreditsPer100: recordings });
  const example = parsed.ok ? exampleCharge(parsed.data) : null;

  function save() {
    startSave(async () => {
      const result = await saveWeldpanelPricing({ eventsCreditsPer10k: events, recordingsCreditsPer100: recordings });
      if (result.ok) {
        toast.success(copy.saved);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function resetToDefaults() {
    setEvents(String(pricing.defaults.eventsCreditsPer10k));
    setRecordings(String(pricing.defaults.recordingsCreditsPer100));
  }

  return (
    <PageContent>
      <PageBody className="space-y-6" width="narrow">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <Activity className="h-6 w-6 text-primary" />
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
                <p className="text-xs text-muted-foreground">{copy.eventsLabel}</p>
                <p className="mt-1 text-lg font-medium tabular-nums">{pricing.effective.eventsCreditsPer10k}</p>
                <p className="text-xs text-muted-foreground">{copy.eventsUnit}</p>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent className="px-4">
                <p className="text-xs text-muted-foreground">{copy.recordingsLabel}</p>
                <p className="mt-1 text-lg font-medium tabular-nums">{pricing.effective.recordingsCreditsPer100}</p>
                <p className="text-xs text-muted-foreground">{copy.recordingsUnit}</p>
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
              <Label htmlFor="panel-pricing-events">{copy.eventsInputLabel}</Label>
              <Input
                id="panel-pricing-events"
                type="number"
                inputMode="numeric"
                min="1"
                max={MAX_CREDITS_PER_BLOCK}
                step="1"
                value={events}
                onChange={(e) => setEvents(e.target.value)}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="panel-pricing-recordings">{copy.recordingsInputLabel}</Label>
              <Input
                id="panel-pricing-recordings"
                type="number"
                inputMode="numeric"
                min="1"
                max={MAX_CREDITS_PER_BLOCK}
                step="1"
                value={recordings}
                onChange={(e) => setRecordings(e.target.value)}
                disabled={isSaving}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{fill(copy.inputHelp, { max: MAX_CREDITS_PER_BLOCK })}</p>

          <Card className="py-4">
            <CardContent className="px-4">
              <p className="text-xs font-medium text-muted-foreground">{copy.exampleHeading}</p>
              <p className="mt-1 text-sm">
                {example
                  ? fill(copy.exampleLine, {
                      events: EXAMPLE_EVENTS.toLocaleString('en-US'),
                      recordings: EXAMPLE_RECORDINGS.toLocaleString('en-US'),
                      eventsCredits: example.events,
                      recordingsCredits: example.recordings,
                      total: example.total,
                    })
                  : copy.exampleInvalid}
              </p>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">{copy.allowancesNote}</p>
          <p className="text-xs text-muted-foreground">{copy.cacheNote}</p>
          <p className="text-xs text-muted-foreground">
            {fill(copy.defaultsNote, {
              events: pricing.defaults.eventsCreditsPer10k,
              recordings: pricing.defaults.recordingsCreditsPer100,
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
