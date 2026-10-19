/** The columns of the prospects table. */

import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachProspect } from '@weldsuite/app-api-client/schemas/reach';
import type { ColumnDef } from '@/components/panel-entity-list';
import { ValidationBadge } from '@/app/weldreach/components/engage/badges';
import { personName, useReachFormat } from '@/app/weldreach/components/engage/format';

const SOURCE_KEYS: Record<ReachProspect['source'], string> = {
  csv: 'reachEngage.prospects.sources.csv',
  crm_list: 'reachEngage.prospects.sources.crm_list',
  welddata: 'reachEngage.prospects.sources.welddata',
  manual: 'reachEngage.prospects.sources.manual',
};

export function useProspectColumns({
  selected,
  onToggle,
}: Readonly<{ selected: Set<string>; onToggle: (id: string) => void }>): ColumnDef<ReachProspect>[] {
  const t = useTranslations();
  const format = useReachFormat();

  return [
    {
      id: 'select',
      header: '',
      width: 'w-6',
      render: (prospect) => (
        <Checkbox
          checked={selected.has(prospect.id)}
          onCheckedChange={() => onToggle(prospect.id)}
          aria-label={t('reachEngage.prospects.selectRow', { email: prospect.email })}
        />
      ),
    },
    {
      id: 'prospect',
      header: t('reachEngage.prospects.table.prospect'),
      width: 'flex-1',
      render: (prospect) => {
        const name = personName(prospect);
        return (
          <span className="block min-w-0">
            <span className="block truncate text-sm font-medium">{name ?? prospect.email}</span>
            {name && <span className="block truncate text-xs text-muted-foreground">{prospect.email}</span>}
          </span>
        );
      },
    },
    {
      id: 'company',
      header: t('reachEngage.prospects.table.company'),
      width: 'hidden md:block md:w-[220px]',
      render: (prospect) => (
        <span className="block min-w-0">
          <span className="block truncate text-sm">{prospect.companyName ?? '—'}</span>
          {prospect.title && (
            <span className="block truncate text-xs text-muted-foreground">{prospect.title}</span>
          )}
        </span>
      ),
    },
    {
      id: 'validation',
      header: t('reachEngage.prospects.table.validation'),
      width: 'w-[110px]',
      render: (prospect) => <ValidationBadge validation={prospect.validation} />,
    },
    {
      id: 'source',
      header: t('reachEngage.prospects.table.source'),
      width: 'hidden lg:block lg:w-[130px]',
      render: (prospect) => (
        <span className="text-sm text-muted-foreground">{t(SOURCE_KEYS[prospect.source])}</span>
      ),
    },
    {
      id: 'added',
      header: t('reachEngage.prospects.table.added'),
      width: 'hidden lg:block lg:w-[120px]',
      render: (prospect) => (
        <span className="text-sm tabular-nums">{format.date(prospect.createdAt)}</span>
      ),
    },
  ];
}
