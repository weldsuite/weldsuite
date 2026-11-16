import { useState, type CSSProperties, type ReactNode } from 'react';
import { Pencil, Users } from 'lucide-react';
import { GanttSidebar } from '@weldsuite/ui/components/gantt';
import type { CapacityBand, CapacityResponse, MemberCapacity } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { MemberSidebarRow } from '@/components/weldflow/workload/member-sidebar-row';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { BAND_CLASS, BANDS, bandOf, dayOfMonth, groupBySkill, intlLocaleOf, monthSpans, percentOf, type SkillGroup } from '../_lib/capacity';

/**
 * The timeline view's sizes (its `GanttProvider` header and row heights), so
 * switching between the two workload views keeps the member list in place.
 * The member list's width, `--cap-sidebar` on the section, is the gantt's
 * `SIDEBAR_WIDTH` (380px), narrower on a phone.
 */
const HEADER_HEIGHT = 60;
const ROW_HEIGHT = 60;
const PROJECT_ROW_HEIGHT = 36;
/** The narrowest a week column gets before the weeks scroll sideways. */
const MIN_WEEK_WIDTH = 64;

/** A week column; the lines run from the header to the bottom, as in the timeline. */
const WEEK_CELL = 'border-r border-border/50';

function weekColumns(weeks: number): string {
  return `repeat(${weeks}, minmax(0, 1fr))`;
}

type Format = (s: string, v: Record<string, unknown>) => string;

function cellLabel(
  copy: { cell: string; cellTentative: string; cellNoContract: string },
  format: Format,
  percent: number | null,
  hours: number,
  tentative: number,
): string {
  const base = percent === null ? format(copy.cellNoContract, { hours }) : format(copy.cell, { percent: Math.round(percent), hours });
  return tentative > 0 ? `${base}. ${format(copy.cellTentative, { tentative })}` : base;
}

/** One heatmap cell: the colour fills the whole week, a dot in the corner marks tentative load. */
function Cell({
  hours,
  tentativeHours,
  percent,
  band,
  label,
}: Readonly<{ hours: number; tentativeHours: number; percent: number | null; band: CapacityBand; label: string }>) {
  const text = percent === null ? `${hours} h` : `${Math.round(percent)}%`;
  return (
    <div
      title={label}
      aria-label={label}
      className={cn(WEEK_CELL, 'relative flex items-center justify-center text-xs font-medium tabular-nums', BAND_CLASS[band])}
    >
      {hours <= 0 ? '–' : text}
      {tentativeHours > 0 ? <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-current" /> : null}
    </div>
  );
}

/** One line of the week grid, as tall as its line in the member list. */
function WeekRow({ weeks, height, children }: Readonly<{ weeks: number; height: number; children: ReactNode }>) {
  return (
    <div className="grid border-b border-border/50" style={{ gridTemplateColumns: weekColumns(weeks), height }}>
      {children}
    </div>
  );
}

/** The project lines under an opened person, in the member list (like the timeline's task lines). */
function ProjectSidebarRow({ name, muted }: Readonly<{ name: string; muted: boolean }>) {
  return (
    <div className="flex w-full items-center gap-2.5 p-2.5 pl-6 text-xs" style={{ height: PROJECT_ROW_HEIGHT }}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
      <p className={cn('flex-1 truncate text-muted-foreground', muted && 'italic')}>{name}</p>
    </div>
  );
}

/** A skill group in the member list: not a person, so an icon instead of an avatar, like the timeline's Unassigned line. */
function GroupSidebarRow({ label, people }: Readonly<{ label: string; people: string }>) {
  return (
    <div className="flex w-full items-center gap-3 border-b border-border/50 px-3" style={{ height: ROW_HEIGHT }}>
      <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
        <Users className="h-4 w-4" />
      </span>
      <span className="block min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      <span className="block shrink-0 text-xs text-muted-foreground">{people}</span>
    </div>
  );
}

function memberCells(member: MemberCapacity, copy: Parameters<typeof cellLabel>[0], format: Format) {
  return member.cells.map((cell, i) => (
    <Cell
      key={i}
      hours={cell.hours}
      tentativeHours={cell.tentativeHours}
      percent={cell.percent}
      band={cell.band}
      label={cellLabel(copy, format, cell.percent, cell.hours, cell.tentativeHours)}
    />
  ));
}

function groupCells(group: SkillGroup, copy: Parameters<typeof cellLabel>[0], format: Format) {
  return group.hours.map((hours, i) => {
    const percent = percentOf(hours, group.capacity[i]);
    const rounded = Math.round(hours * 100) / 100;
    return <Cell key={i} hours={hours} tentativeHours={0} percent={percent} band={bandOf(hours, percent)} label={cellLabel(copy, format, percent, rounded, 0)} />;
  });
}

function projectKey(row: MemberCapacity['projects'][number]): string {
  return `${row.projectId ?? ''}:${row.requestId ?? ''}`;
}

interface HeatmapProps {
  load: CapacityResponse;
  groupBy: 'person' | 'skill';
  canEdit: boolean;
  nameOf: (id: string) => string;
  pictureOf: (id: string) => string | undefined;
  onEdit: (memberId: string) => void;
}

/**
 * People (or skills) by ISO week, as a percentage of contract hours, laid out
 * like the timeline view: the same member list (`GanttSidebar` with
 * `MemberSidebarRow`) on the left and the weeks beside it, with the projects
 * behind a person one click away.
 */
export function Heatmap({ load, groupBy, canEdit, nameOf, pictureOf, onEdit }: Readonly<HeatmapProps>) {
  const { t, format, language } = useI18n();
  const copy = t.flowPortfolio.capacity;
  const heat = copy.heatmap;
  const locale = intlLocaleOf(language);
  const weeks = load.weeks.length;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (memberId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });

  const sidebar: ReactNode[] = [];
  const grid: ReactNode[] = [];
  if (groupBy === 'skill') {
    for (const group of groupBySkill(load.members, weeks)) {
      sidebar.push(<GroupSidebarRow key={group.key} label={group.label || heat.noSkill} people={format(heat.people, { count: group.members.length })} />);
      grid.push(
        <WeekRow key={group.key} weeks={weeks} height={ROW_HEIGHT}>
          {groupCells(group, heat, format)}
        </WeekRow>,
      );
    }
  } else {
    for (const member of load.members) {
      const name = nameOf(member.memberId);
      const open = expanded.has(member.memberId);
      sidebar.push(
        <MemberSidebarRow
          key={member.memberId}
          name={name}
          image={pictureOf(member.memberId)}
          subtitle={member.skills.join(', ')}
          meta={format(heat.hoursPerWeek, { hours: member.weeklyHours })}
          rowHeight={ROW_HEIGHT}
          isExpanded={open}
          onToggle={() => toggle(member.memberId)}
          toggleLabel={format(open ? heat.hide : heat.show, { name })}
          action={
            canEdit ? (
              <button
                type="button"
                aria-label={format(heat.editProfile, { name })}
                onClick={() => onEdit(member.memberId)}
                className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
              >
                <Pencil className="size-3" />
              </button>
            ) : undefined
          }
        />,
      );
      grid.push(
        <WeekRow key={member.memberId} weeks={weeks} height={ROW_HEIGHT}>
          {memberCells(member, heat, format)}
        </WeekRow>,
      );
      if (!open) continue;
      for (const row of member.projects) {
        const key = `${member.memberId}:${projectKey(row)}`;
        sidebar.push(<ProjectSidebarRow key={key} name={row.accessible ? row.name : heat.otherProject} muted={!row.accessible} />);
        grid.push(
          <WeekRow key={key} weeks={weeks} height={PROJECT_ROW_HEIGHT}>
            {row.hours.map((h, i) => (
              <div key={i} className={cn(WEEK_CELL, 'flex items-center justify-center text-[11px] text-foreground/80 tabular-nums')}>
                {h > 0 ? `${h} h` : heat.nothing}
              </div>
            ))}
          </WeekRow>,
        );
      }
    }
  }

  const frame = {
    '--gantt-header-height': `${HEADER_HEIGHT}px`,
    gridTemplateColumns: `var(--cap-sidebar) minmax(${weeks * MIN_WEEK_WIDTH}px, 1fr)`,
  } as CSSProperties;

  return (
    <section aria-label={heat.title} className="flex min-h-0 flex-1 flex-col [--cap-sidebar:200px] md:[--cap-sidebar:380px]">
      <div className="min-h-0 flex-1 overflow-auto bg-secondary">
        <div className="grid min-h-full w-max min-w-full" style={frame}>
          <GanttSidebar sidebarLabel={groupBy === 'skill' ? heat.group : heat.person} sidebarSecondaryLabel={groupBy === 'skill' ? heat.peopleHeader : heat.contractHours}>
            <div className="flex flex-col">
              {load.members.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center p-4 text-center">
                  <p className="text-xs text-muted-foreground">{heat.empty}</p>
                </div>
              ) : (
                sidebar
              )}
            </div>
          </GanttSidebar>

          <div className="flex min-w-0 flex-col">
            <div
              className="sticky top-0 z-20 grid shrink-0 bg-background/90 backdrop-blur-sm"
              style={{ gridTemplateColumns: weekColumns(weeks), gridTemplateRows: '1fr auto', height: HEADER_HEIGHT }}
            >
              {monthSpans(load.weeks, locale).map((month) => (
                <div
                  key={month.key}
                  className={cn(WEEK_CELL, 'truncate px-3 py-2 text-xs whitespace-nowrap text-muted-foreground')}
                  style={{ gridRow: 1, gridColumn: `span ${month.span}` }}
                >
                  {month.label}
                </div>
              ))}
              {load.weeks.map((week) => (
                <div key={week.week} title={week.week} className={cn(WEEK_CELL, 'border-b py-1 text-center text-xs')} style={{ gridRow: 2 }}>
                  {dayOfMonth(week.startsOn)}
                </div>
              ))}
            </div>
            {grid}
            {/* The week lines carry on to the bottom, as in the timeline. */}
            <div aria-hidden className="grid flex-1" style={{ gridTemplateColumns: weekColumns(weeks) }}>
              {load.weeks.map((week) => (
                <div key={week.week} className={WEEK_CELL} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <ul className="flex shrink-0 flex-wrap items-center gap-4 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <li className="font-medium text-foreground/80">{heat.unit}</li>
        {BANDS.map((band) => (
          <li key={band} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('h-3.5 w-5 rounded-sm', BAND_CLASS[band])} />
            {copy.legend[band]}
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 rounded-full bg-foreground/70" />
          {copy.legend.tentative}
        </li>
      </ul>
    </section>
  );
}
