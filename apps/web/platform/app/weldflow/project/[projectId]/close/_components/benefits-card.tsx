import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useHandOver } from '@/hooks/queries/use-project-closing-queries';
import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import { formatShortDate } from '@/app/weldflow/project/[projectId]/raid/_lib/raid';
import { apiMessage } from '../_lib/api-error';
import { benefitNeeds, formatMeasure, formatPeriod } from '../_lib/close';
import { useClose } from './close-context';
import { MemberSelect } from './member-select';

const STATUS_STYLE: Record<string, string> = {
  planned: 'bg-muted text-foreground/80',
  measuring: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  at_risk: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
  realised: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  closed: 'bg-muted text-foreground/80',
};

/** The final benefit measurements, and the hand-over of benefit tracking to one person. */
export function BenefitsCard() {
  const { t, language, format } = useI18n();
  const copy = t.flowClosing.close.benefits;
  const { checklist, projectId, members, memberOf, abilities, userId } = useClose();
  const locale = intlLocaleOf(language);
  const benefits = checklist.benefits;
  const sponsorId = checklist.signOff.sponsorId;
  const [ownerId, setOwnerId] = useState<string | null>(sponsorId ?? userId);
  const handOver = useHandOver(projectId);
  const statusText = copy.status as Record<string, string>;

  const apply = async () => {
    if (!ownerId || benefits.length === 0) return;
    try {
      await handOver.mutateAsync({ benefits: benefits.map((benefit) => ({ id: benefit.id, ownerId })) });
      toast.success(format(copy.footer.success, { name: memberOf(ownerId)?.name ?? t.flowClosing.shared.unknownMember }));
    } catch (error) {
      toast.error(apiMessage(error, copy.footer.failed));
    }
  };

  return (
    <section aria-labelledby="close-benefits-title" className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline gap-2 border-b px-4 py-3.5">
        <h3 id="close-benefits-title" className="text-sm font-semibold">
          {copy.title}
        </h3>
        <span className="text-xs text-muted-foreground">{copy.subtitle}</span>
      </div>
      {benefits.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{copy.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">{copy.columns.benefit}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">{copy.columns.baseline}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">{copy.columns.target}</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">{copy.columns.latest}</th>
                <th scope="col" className="px-2 py-2 font-medium">{copy.columns.status}</th>
                <th scope="col" className="px-4 py-2 font-medium">{copy.columns.owner}</th>
              </tr>
            </thead>
            <tbody>
              {benefits.map((benefit) => {
                const needs = benefitNeeds(benefit);
                const owner = memberOf(benefit.ownerId);
                return (
                  <tr key={benefit.id} className={cn('border-t', (needs.owner || needs.measurement) && 'bg-orange-50/40 dark:bg-orange-950/10')}>
                    <th scope="row" className="px-4 py-2 text-left font-medium">
                      <span className="font-normal text-muted-foreground">{benefit.code}</span> {benefit.title}
                      {benefit.realiseBy ? (
                        <div className="text-xs font-normal text-muted-foreground">
                          {format(copy.targetBy, { date: formatShortDate(benefit.realiseBy, locale) })}
                        </div>
                      ) : null}
                    </th>
                    <td className="px-2 py-2 text-right whitespace-nowrap text-foreground/80">{formatMeasure(benefit.baselineValue, benefit.unit, locale)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap text-foreground/80">{formatMeasure(benefit.targetValue, benefit.unit, locale)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      {benefit.latest ? (
                        <>
                          <span className="font-semibold">{formatMeasure(benefit.latest.value, benefit.unit, locale)}</span>
                          <div className="text-xs text-muted-foreground">{formatPeriod(benefit.latest.period, locale)}</div>
                        </>
                      ) : (
                        <span className="text-xs font-medium text-orange-700 dark:text-orange-400">{copy.needsMeasurement}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', STATUS_STYLE[benefit.status] ?? STATUS_STYLE.planned)}>
                        {statusText[benefit.status] ?? benefit.status}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      {benefit.ownerId ? (
                        <span>{owner?.name ?? t.flowClosing.shared.unknownMember}</span>
                      ) : (
                        <span className="text-xs font-medium text-orange-700 dark:text-orange-400">{copy.needsOwner}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {abilities.manage && benefits.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-4 py-3">
          <span className="text-[13px] text-foreground/80">{copy.footer.hint}</span>
          <Label htmlFor="benefits-owner" className="font-normal text-foreground/80">
            {copy.footer.handTo}
          </Label>
          <div className="min-w-[12rem]">
            <MemberSelect
              id="benefits-owner"
              members={members}
              value={ownerId}
              onChange={setOwnerId}
              placeholder={t.flowClosing.shared.choosePerson}
              suffixOf={(member) => (member.userId === sponsorId ? format(copy.footer.sponsorSuffix, { name: member.name }) : null)}
            />
          </div>
          <Button type="button" size="sm" onClick={() => void apply()} disabled={!ownerId || handOver.isPending}>
            {handOver.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {handOver.isPending ? copy.footer.applying : copy.footer.apply}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
