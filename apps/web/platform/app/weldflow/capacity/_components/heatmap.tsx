import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import type { CapacityBand, CapacityResponse, MemberCapacity } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { BAND_CLASS, BANDS, bandOf, formatDay, groupBySkill, intlLocaleOf, percentOf, type SkillGroup } from '../_lib/capacity';

const PERSON_COLUMN = '220px';

function gridColumns(weeks: number): string {
  return `${PERSON_COLUMN} repeat(${weeks}, minmax(48px, 1fr))`;
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

/** One heatmap cell: the percentage of contract hours, tentative load dashed. */
function Cell({
  hours,
  tentativeHours,
  percent,
  band,
  label,
}: Readonly<{ hours: number; tentativeHours: number; percent: number | null; band: CapacityBand; label: string }>) {
  const tentative = tentativeHours > 0;
  const text = percent === null ? `${hours} h` : `${Math.round(percent)}%`;
  return (
    <div
      title={label}
      aria-label={label}
      className={cn(
        'flex h-8 items-center justify-center rounded-md text-[11px] font-semibold tabular-nums',
        BAND_CLASS[band],
        tentative && 'border-[1.5px] border-dashed border-foreground/50 italic',
      )}
    >
      {hours <= 0 ? '–' : `${tentative ? '~' : ''}${text}`}
    </div>
  );
}

interface PersonRowProps {
  member: MemberCapacity;
  name: string;
  weeks: number;
  canEdit: boolean;
  onEdit: (memberId: string) => void;
}

function PersonRow({ member, name, weeks, canEdit, onEdit }: Readonly<PersonRowProps>) {
  const { t, format } = useI18n();
  const copy = t.flowPortfolio.capacity.heatmap;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="grid items-center gap-[3px] px-3 py-[3px]" style={{ gridTemplateColumns: gridColumns(weeks) }}>
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={format(open ? copy.hide : copy.show, { name })}
            onClick={() => setOpen(!open)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {[member.skills.join(', '), format(copy.hoursPerWeek, { hours: member.weeklyHours })].filter(Boolean).join(' · ')}
            </div>
          </div>
          {canEdit ? (
            <button
              type="button"
              aria-label={format(copy.editProfile, { name })}
              onClick={() => onEdit(member.memberId)}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            >
              <Pencil className="size-3" />
            </button>
          ) : null}
        </div>
        {member.cells.map((cell, i) => (
          <Cell
            key={i}
            hours={cell.hours}
            tentativeHours={cell.tentativeHours}
            percent={cell.percent}
            band={cell.band}
            label={cellLabel(copy, format, cell.percent, cell.hours, cell.tentativeHours)}
          />
        ))}
      </div>
      {open
        ? member.projects.map((row) => (
            <div
              key={`${row.projectId ?? ''}:${row.requestId ?? ''}`}
              className="grid items-center gap-[3px] bg-muted/30 px-3 py-0.5"
              style={{ gridTemplateColumns: gridColumns(weeks) }}
            >
              <div className={cn('truncate pl-9 text-xs', !row.accessible && 'text-muted-foreground italic')}>
                {row.accessible ? row.name : copy.otherProject}
              </div>
              {row.hours.map((h, i) => (
                <div key={i} className="flex h-6 items-center justify-center text-[11px] text-foreground/80 tabular-nums">
                  {h > 0 ? `${h} h` : copy.nothing}
                </div>
              ))}
            </div>
          ))
        : null}
    </>
  );
}

function GroupRow({ group, weeks, label }: Readonly<{ group: SkillGroup; weeks: number; label: string }>) {
  const { t, format } = useI18n();
  const copy = t.flowPortfolio.capacity.heatmap;
  return (
    <div className="grid items-center gap-[3px] px-3 py-[3px]" style={{ gridTemplateColumns: gridColumns(weeks) }}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="truncate text-[11px] text-muted-foreground">{format(copy.people, { count: group.members.length })}</div>
      </div>
      {group.hours.map((hours, i) => {
        const percent = percentOf(hours, group.capacity[i]);
        const rounded = Math.round(hours * 100) / 100;
        return (
          <Cell
            key={i}
            hours={hours}
            tentativeHours={0}
            percent={percent}
            band={bandOf(hours, percent)}
            label={cellLabel(copy, format, percent, rounded, 0)}
          />
        );
      })}
    </div>
  );
}

interface HeatmapProps {
  load: CapacityResponse;
  groupBy: 'person' | 'skill';
  canEdit: boolean;
  nameOf: (id: string) => string;
  onEdit: (memberId: string) => void;
}

/** People (or skills) by ISO week, as a percentage of contract hours, with the projects behind a person one click away. */
export function Heatmap({ load, groupBy, canEdit, nameOf, onEdit }: Readonly<HeatmapProps>) {
  const { t, language } = useI18n();
  const copy = t.flowPortfolio.capacity;
  const locale = intlLocaleOf(language);
  const weeks = load.weeks.length;
  const groups = groupBy === 'skill' ? groupBySkill(load.members, weeks) : [];
  let rows;
  if (load.members.length === 0) {
    rows = <p className="px-4 py-10 text-center text-sm text-muted-foreground">{copy.heatmap.empty}</p>;
  } else if (groupBy === 'skill') {
    rows = groups.map((group) => <GroupRow key={group.key} group={group} weeks={weeks} label={group.label || copy.heatmap.noSkill} />);
  } else {
    rows = load.members.map((member) => (
      <PersonRow key={member.memberId} member={member} name={nameOf(member.memberId)} weeks={weeks} canEdit={canEdit} onEdit={onEdit} />
    ));
  }
  return (
    <section aria-labelledby="heat-title" className="min-w-0 flex-[999_1_720px] overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h2 id="heat-title" className="flex-1 text-[15px] font-semibold">
          {copy.heatmap.title}
        </h2>
        <span className="text-xs text-muted-foreground">{copy.heatmap.unit}</span>
      </div>
      <div className="overflow-x-auto">
        <div style={{ minWidth: 220 + weeks * 52 }}>
          <div
            className="grid gap-[3px] px-3 pt-2.5 pb-1.5 text-[11px] font-medium text-muted-foreground"
            style={{ gridTemplateColumns: gridColumns(weeks) }}
          >
            <span>{groupBy === 'skill' ? copy.heatmap.group : copy.heatmap.person}</span>
            {load.weeks.map((week) => (
              <span key={week.week} title={week.week} className="text-center whitespace-nowrap">
                {formatDay(week.startsOn, locale)}
              </span>
            ))}
          </div>
          {rows}
          <div className="h-2.5" />
        </div>
      </div>
      <ul className="flex flex-wrap gap-4 border-t px-4 py-3 text-xs text-muted-foreground">
        {BANDS.map((band) => (
          <li key={band} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('h-3.5 w-5 rounded-sm', BAND_CLASS[band])} />
            {copy.legend[band]}
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3.5 w-5 rounded-sm border-[1.5px] border-dashed border-foreground/50" />
          {copy.legend.tentative}
        </li>
      </ul>
    </section>
  );
}
