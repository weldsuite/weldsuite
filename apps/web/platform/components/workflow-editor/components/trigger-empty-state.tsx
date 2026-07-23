
import { Zap, Clock, Globe, MousePointerClick } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import type { ComponentType } from 'react';

type TriggerType = 'entity_event' | 'schedule' | 'webhook' | 'manual';

interface TriggerTileProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick: () => void;
  iconClassName?: string;
  iconBgClassName?: string;
}

function TriggerTile({ icon: Icon, title, description, onClick, iconClassName, iconBgClassName }: TriggerTileProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border bg-card p-4 text-left',
        'transition-all hover:border-foreground/20 hover:shadow-sm hover:bg-accent/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      <div className={cn('flex h-10 w-10 items-center justify-center rounded-md', iconBgClassName)}>
        <Icon className={cn('h-5 w-5', iconClassName)} />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold leading-none">{title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </Button>
  );
}

interface TriggerEmptyStateProps {
  onSelectType: (type: TriggerType) => void;
}

export function TriggerEmptyState({ onSelectType }: TriggerEmptyStateProps) {
  const { t } = useI18n();
  const tes = t.weldconnect.triggerEmptyState;

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-1.5">
          <h2 className="text-base font-semibold">{tes.title}</h2>
          <p className="text-sm text-muted-foreground">{tes.subtitle}</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TriggerTile
            icon={Zap}
            title={tes.entityEvent}
            description={tes.entityEventDesc}
            onClick={() => onSelectType('entity_event')}
            iconClassName="text-purple-600 dark:text-purple-400"
            iconBgClassName="bg-purple-100 dark:bg-purple-900/30"
          />
          <TriggerTile
            icon={Clock}
            title={tes.schedule}
            description={tes.scheduleDesc}
            onClick={() => onSelectType('schedule')}
            iconClassName="text-blue-600 dark:text-blue-400"
            iconBgClassName="bg-blue-100 dark:bg-blue-900/30"
          />
          <TriggerTile
            icon={Globe}
            title={tes.webhook}
            description={tes.webhookDesc}
            onClick={() => onSelectType('webhook')}
            iconClassName="text-emerald-600 dark:text-emerald-400"
            iconBgClassName="bg-emerald-100 dark:bg-emerald-900/30"
          />
          <TriggerTile
            icon={MousePointerClick}
            title={tes.manual}
            description={tes.manualDesc}
            onClick={() => onSelectType('manual')}
            iconClassName="text-orange-600 dark:text-orange-400"
            iconBgClassName="bg-orange-100 dark:bg-orange-900/30"
          />
        </div>
      </div>
    </div>
  );
}
