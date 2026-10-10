/**
 * Settings > Billing (and Plans) for a partner-managed workspace: no plans,
 * checkout, top-ups or invoices, because the partner bills the customer. Shows
 * who to contact and what the licence includes.
 */

import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Progress } from '@weldsuite/ui/components/progress';
import type { ManagedBillingInfo } from '@weldsuite/app-api-client/schemas/partners';
import { getAppShortName } from '@/lib/apps/app-registry';
import { useI18n } from '@/lib/i18n/provider';
import { PartnerContactLinks, PartnerLogo } from './partner-contact';

const STATUS_VARIANT = { active: 'success', suspended: 'warning', ended: 'secondary' } as const;

export function ManagedBillingView({ info }: Readonly<{ info: ManagedBillingInfo }>) {
  const { t, format, language } = useI18n();
  const tm = t.partner.managed;
  const { partner, licence } = info;
  const number = new Intl.NumberFormat(language);

  const creditsTotal = licence.monthlyCredits;
  const creditsPercent = creditsTotal > 0 ? Math.min(100, (info.creditsUsedThisPeriod / creditsTotal) * 100) : 0;

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex items-start gap-4">
        <PartnerLogo partner={partner} className="h-12 w-12" />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{format(tm.title, { partner: partner.name })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{format(tm.description, { partner: partner.name })}</p>
        </div>
      </div>

      {info.readOnly && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">{tm.readOnlyTitle}</p>
          <p className="text-muted-foreground">{format(tm.readOnlyBody, { partner: partner.name })}</p>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{format(tm.contactHeading, { partner: partner.name })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PartnerContactLinks partner={partner} />
            {partner.supportEmail && (
              <p className="text-sm text-muted-foreground">{format(tm.needMore, { partner: partner.name })}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{tm.licenceHeading}</CardTitle>
            <Badge variant={STATUS_VARIANT[licence.status]}>{t.partner.licenceStatus[licence.status]}</Badge>
          </CardHeader>
          <CardContent className="space-y-5">
            <div>
              <p className="mb-2 text-sm font-medium">{tm.apps}</p>
              {licence.allowedApps.length === 0 ? (
                <p className="text-sm text-muted-foreground">{tm.appsEmpty}</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {licence.allowedApps.map((code) => (
                    <li key={code}>
                      <Badge variant="secondary">{getAppShortName(code, code)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium">{tm.credits}</p>
              <Progress value={creditsPercent} aria-label={tm.credits} />
              <p className="text-xs text-muted-foreground">
                {format(tm.creditsValue, {
                  used: number.format(info.creditsUsedThisPeriod),
                  allowance: number.format(creditsTotal),
                })}
                {' · '}
                {format(tm.creditsBalance, { balance: number.format(info.creditBalance) })}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">{tm.seats}</p>
              <p className="text-sm text-muted-foreground">
                {licence.maxSeats === null
                  ? format(tm.seatsUnlimited, { used: info.activeMembers })
                  : format(tm.seatsValue, { used: info.activeMembers, max: licence.maxSeats })}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
