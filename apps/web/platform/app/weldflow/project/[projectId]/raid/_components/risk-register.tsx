import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import { intlLocaleOf } from '../_lib/locale';
import { categoryLabel, strategyLabel } from '../_lib/copy';
import { formatShortDate } from '../_lib/raid';
import type { MatrixCellRef } from '../_lib/risk';
import { TaskProgress } from './raid-parts';
import { ListDue, ListOwner, ListScore, ListStatus, ListText, RaidItemList, titleColumn, type RaidListColumn } from './raid-list';
import { useRaid } from './raid-context';

interface RiskRegisterProps {
  /** The risks to list, already filtered and in register order. */
  risks: RaidItem[];
  /** The matrix cell the register is filtered to, if any. */
  cell: MatrixCellRef | null;
}

/** The risk register under the matrix, as the standard list. */
export function RiskRegister({ risks, cell }: Readonly<RiskRegisterProps>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();
  const intlLocale = intlLocaleOf(language);

  const columns: RaidListColumn[] = [
    titleColumn(copy.columns.risk),
    { id: 'category', header: copy.detail.category, width: 'hidden w-[120px] @7xl:flex', render: (risk) => <ListText text={categoryLabel(copy, risk.category)} /> },
    { id: 'strategy', header: copy.detail.strategy, width: 'hidden w-[100px] @[90rem]:flex', render: (risk) => <ListText text={strategyLabel(copy, risk.strategy)} /> },
    {
      id: 'score',
      header: copy.columns.score,
      width: 'hidden w-[110px] @lg:flex',
      render: (risk) => (risk.score !== null && risk.band !== null ? <ListScore score={risk.score} band={risk.band} /> : null),
    },
    { id: 'owner', header: copy.columns.owner, width: 'hidden w-[150px] @3xl:flex', render: (risk) => <ListOwner ownerId={risk.ownerId} /> },
    { id: 'status', header: copy.columns.status, width: 'w-[120px]', render: (risk) => <ListStatus kind="risk" status={risk.status} /> },
    {
      id: 'mitigation',
      header: copy.columns.mitigation,
      width: 'hidden w-[140px] @5xl:flex',
      render: (risk) =>
        risk.taskProgress.total > 0 ? (
          <TaskProgress progress={risk.taskProgress} />
        ) : (
          <ListText text={risk.strategy === 'accept' ? copy.register.noTasksAccepted : copy.register.noTasks} />
        ),
    },
    {
      id: 'nextReview',
      header: copy.columns.nextReview,
      width: 'hidden w-[104px] @4xl:flex',
      render: (risk) => (
        <ListDue
          dueAt={risk.dueAt}
          closedText={risk.closedAt ? format(copy.due.closedOn, { date: formatShortDate(risk.closedAt, intlLocale, now) }) : null}
        />
      ),
    },
  ];

  return (
    <RaidItemList
      label={copy.register.title}
      items={risks}
      columns={columns}
      emptyText={cell ? copy.register.noRisksInCell : copy.register.noMatches}
    />
  );
}
