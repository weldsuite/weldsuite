/**
 * Shown while replenishment is off for the workspace (`replenishmentEnabled`
 * false, the default): what it does, and a switch for people who can manage
 * inventory. Everyone else gets the explanation and who to ask.
 */

import { CalendarClock, LineChart, ShoppingCart, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { getTranslations } from '@/lib/i18n';
import { useStartPlanningRun, useUpdateReplenishmentSettings } from '@/hooks/queries/use-replenishment-queries';

export function EnableScreen({ onOpenSettings }: Readonly<{ onOpenSettings: () => void }>) {
  const t = getTranslations('weldstashReplenishment').enable;
  const { can } = usePermissions();
  const update = useUpdateReplenishmentSettings();
  const startRun = useStartPlanningRun();

  const enable = async () => {
    try {
      await update.mutateAsync({ replenishmentEnabled: true });
      toast.success(t.toastEnabled);
      // Plans are empty until a run has happened: start the first one now instead of waiting for the night.
      await startRun.mutateAsync().catch(() => undefined);
    } catch (err) {
      toast.error((err as Error).message || t.enableFailed);
    }
  };

  const steps = [
    { icon: TrendingUp, title: t.steps.forecastTitle, body: t.steps.forecastBody },
    { icon: CalendarClock, title: t.steps.reorderTitle, body: t.steps.reorderBody },
    { icon: ShoppingCart, title: t.steps.orderTitle, body: t.steps.orderBody },
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <LineChart className="size-5" aria-hidden />
          <span className="text-sm font-medium">{t.eyebrow}</span>
        </div>
        <h2 className="text-2xl font-semibold">{t.title}</h2>
        <p className="text-sm text-muted-foreground">{t.description}</p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-3">
        {steps.map(({ icon: Icon, title, body }) => (
          <li key={title} className="rounded-lg border p-4">
            <Icon className="mb-2 size-5 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          </li>
        ))}
      </ul>

      {can('inventory:manage') ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void enable()} disabled={update.isPending}>
            {update.isPending ? t.enabling : t.enable}
          </Button>
          <Button variant="outline" onClick={onOpenSettings}>
            {t.openSettings}
          </Button>
          <span className="text-sm text-muted-foreground">{t.enableHint}</span>
        </div>
      ) : (
        <InfoBanner variant="neutral">{t.noPermission}</InfoBanner>
      )}
    </div>
  );
}
