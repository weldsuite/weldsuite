import type { Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { PersonAvatar } from '../../../raid/_components/raid-parts';
import { QUADRANTS, quadrantOf, stakeholderName } from './stakeholder-model';

/** An axis bar of the grid: the page background with the small uppercase title, as the risk matrix draws its axes. */
const AXIS_BAR = 'flex items-center justify-center bg-background text-[11px] font-semibold uppercase tracking-wider text-foreground';

interface PowerGridProps {
  /** Every stakeholder of the project, whatever the list is filtered to. */
  rows: readonly Stakeholder[];
  /** The stakeholder whose panel is open. */
  selectedId: string | null;
  /** The avatar of a team member, if the project has them. */
  avatarOf: (row: Stakeholder) => string | null;
  onOpen: (id: string) => void;
}

/**
 * The power / interest grid: four quadrants in the grid-lines of the risk
 * matrix, people as avatars. High influence is up, high interest to the right;
 * a click on a person opens their panel.
 */
export function PowerGrid({ rows, selectedId, avatarOf, onOpen }: Readonly<PowerGridProps>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders.grid;

  return (
    <section aria-labelledby="stakeholder-grid-title">
      <h2 id="stakeholder-grid-title" className="sr-only">
        {copy.title}
      </h2>
      {/* One grid, its 1px gaps the lines between the quadrants; only the bottom edge draws a border, as the matrix does. */}
      <div className="grid grid-cols-[2rem_repeat(2,minmax(0,1fr))] gap-px border-b border-sidebar-border bg-sidebar-border">
        <div className={cn(AXIS_BAR, 'col-start-1 row-span-2 row-start-1')}>
          <span className="rotate-180 [writing-mode:vertical-rl]">{copy.influence}</span>
        </div>
        {QUADRANTS.map((quadrant) => {
          const members = rows.filter((row) => quadrantOf(row) === quadrant);
          return (
            <div key={quadrant} role="group" aria-label={`${copy[quadrant]}: ${members.length}`} className="flex min-h-40 flex-col gap-2 bg-background p-3">
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs font-semibold">{copy[quadrant]}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">{members.length}</span>
              </div>
              <div className="mt-auto flex flex-wrap gap-1.5">
                {members.map((row) => (
                  <Button
                    key={row.id}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title={stakeholderName(row)}
                    aria-label={stakeholderName(row)}
                    aria-current={row.id === selectedId ? 'true' : undefined}
                    onClick={() => onOpen(row.id)}
                    className={cn('size-8 rounded-[32%] p-0 hover:bg-transparent hover:opacity-80', row.id === selectedId && 'ring-2 ring-foreground')}
                  >
                    <PersonAvatar name={stakeholderName(row) || '?'} avatar={avatarOf(row)} className="size-8 text-xs" />
                  </Button>
                ))}
              </div>
            </div>
          );
        })}
        <div aria-hidden className="bg-background" />
        <div className={cn(AXIS_BAR, 'col-span-2 h-8')}>{copy.interest}</div>
      </div>
    </section>
  );
}
