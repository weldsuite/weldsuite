import { useMemo } from 'react';
import type { ProjectSchedule, ScheduleTask } from '@weldsuite/app-api-client/domains/project-schedule';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  arrowPath,
  buildTimeline,
  dayOf,
  layoutBars,
  monthTicks,
  nonWorkingBands,
  rowCenter,
  xOf,
  type Timeline,
  type Zoom,
} from '../_lib/gantt';
import { fill, intlLocaleOf, shortDate, taskLabel } from '../_lib/format';

const TASK_COLUMN = 260;

interface GanttChartProps {
  schedule: ProjectSchedule;
  rows: readonly ScheduleTask[];
  zoom: Zoom;
  showCritical: boolean;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}

function monthLabel(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', year: month.endsWith('-01') ? 'numeric' : undefined, timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

function barClass(conflict: boolean, critical: boolean): string {
  if (conflict) return 'border-[1.5px] border-red-600 bg-red-50 dark:bg-red-950/40';
  if (critical) return 'border-[1.5px] border-orange-700 bg-orange-100 dark:bg-orange-950/40';
  return 'bg-blue-200 dark:bg-blue-900/60';
}

function linkColor(conflict: boolean, critical: boolean): string {
  if (conflict) return '#c92a2a';
  if (critical) return '#c2410c';
  return '#8a8a8a';
}

function linkLabel(typeName: string, type: string, lagDays: number): string | null {
  if (type === 'fs' && lagDays === 0) return null;
  if (!lagDays) return typeName;
  const sign = lagDays > 0 ? '+' : '';
  return typeName + ' ' + sign + lagDays + ' d';
}

/** The task Gantt: a bar per task, an elbow arrow per dependency, the critical path, conflicts, the go-live and today. */
export function GanttChart({ schedule, rows, zoom, showCritical, selectedId, onSelect }: Readonly<GanttChartProps>) {
  const { t, language } = useI18n();
  const copy = t.flowSchedule.dependencies;
  const locale = intlLocaleOf(language);
  const timeline: Timeline = useMemo(() => buildTimeline(schedule, zoom), [schedule, zoom]);
  const bars = useMemo(() => layoutBars(rows, timeline), [rows, timeline]);
  const conflictedIds = useMemo(() => new Set(schedule.conflicts.map((conflict) => conflict.successorId)), [schedule.conflicts]);
  const conflictedLinks = useMemo(() => new Set(schedule.conflicts.map((conflict) => conflict.linkId)), [schedule.conflicts]);
  const criticalIds = useMemo(() => new Set(schedule.criticalPath), [schedule.criticalPath]);
  const bands = useMemo(
    () => nonWorkingBands(timeline, schedule.settings.workingDays, schedule.settings.holidays),
    [timeline, schedule.settings.workingDays, schedule.settings.holidays],
  );
  const ticks = useMemo(() => monthTicks(timeline), [timeline]);
  const titleOf = useMemo(() => new Map(schedule.tasks.map((task) => [task.id, task])), [schedule.tasks]);

  const todayDay = Math.floor(Date.now() / 86_400_000);
  const goLiveDay = schedule.goLive.date ? dayOf(schedule.goLive.date) : null;
  const height = rows.length * ROW_HEIGHT;

  return (
    <section aria-label={copy.chartLabel} className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="overflow-auto">
        <div className="relative" style={{ width: TASK_COLUMN + timeline.width, minHeight: HEADER_HEIGHT + height }}>
          <div className="sticky top-0 z-20 flex border-b bg-muted/60 text-xs font-medium text-muted-foreground" style={{ height: HEADER_HEIGHT }}>
            <div className="sticky left-0 z-30 flex items-center border-r bg-muted px-3" style={{ width: TASK_COLUMN }}>
              {copy.chart.taskColumn}
            </div>
            <div className="relative" style={{ width: timeline.width }}>
              {ticks.map((tick) => (
                <div key={tick.day} className="absolute top-0 flex h-full items-center border-l pl-2" style={{ left: xOf(timeline, tick.day) }}>
                  {monthLabel(tick.month, locale)}
                </div>
              ))}
            </div>
          </div>

          <div className="relative flex">
            <div className="sticky left-0 z-10 border-r bg-card" style={{ width: TASK_COLUMN }}>
              {rows.map((task) => {
                const critical = showCritical && criticalIds.has(task.id);
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onSelect(task.id)}
                    aria-pressed={selectedId === task.id}
                    className={cn(
                      'flex w-full items-center gap-2 border-b px-3 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      selectedId === task.id && 'bg-primary/5',
                    )}
                    style={{ height: ROW_HEIGHT }}
                  >
                    <span className={cn('shrink-0 text-xs tabular-nums text-muted-foreground', critical && 'font-semibold text-orange-700 dark:text-orange-400')}>
                      {taskLabel(task)}
                    </span>
                    <span className={cn('min-w-0 flex-1 truncate', task.done && 'text-muted-foreground line-through')}>{task.title}</span>
                    {conflictedIds.has(task.id) && (
                      <span className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-800 dark:bg-red-950 dark:text-red-300">
                        {copy.chart.conflict}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="relative" style={{ width: timeline.width, height }}>
              {bands.map(([from, to]) => (
                <div
                  key={from}
                  aria-hidden
                  className="absolute top-0 bg-muted/50"
                  style={{ left: xOf(timeline, from), width: (to - from + 1) * timeline.pxPerDay, height }}
                />
              ))}
              {rows.map((task, index) => (
                <div key={task.id} aria-hidden className="absolute inset-x-0 border-b" style={{ top: (index + 1) * ROW_HEIGHT - 1 }} />
              ))}

              {rows.map((task) => {
                const bar = bars.get(task.id);
                if (!bar) {
                  return (
                    <div key={task.id} className="absolute left-3 text-xs italic text-muted-foreground" style={{ top: bar ? 0 : rows.indexOf(task) * ROW_HEIGHT + 11 }}>
                      {copy.chart.notScheduled}
                    </div>
                  );
                }
                const critical = showCritical && criticalIds.has(task.id);
                const conflict = conflictedIds.has(task.id);
                const progress = Math.min(100, Math.max(0, Number(task.progress) || 0));
                const conflictWith = schedule.conflicts.find((c) => c.successorId === task.id);
                const predecessor = conflictWith ? titleOf.get(conflictWith.predecessorId) : undefined;
                const conflictNote = conflict && predecessor ? `. ${fill(copy.chart.conflictTitle, { predecessor: taskLabel(predecessor) })}` : '';
                return (
                  <div key={task.id}>
                    {bar.pushedX2 > bar.x2 && (
                      <div
                        aria-hidden
                        title={task.earlyStart ? fill(copy.chart.pushed, { date: shortDate(task.earlyStart, locale) }) : undefined}
                        className="absolute rounded border border-dashed border-red-400 bg-red-50/60 dark:bg-red-950/30"
                        style={{ left: bar.x2, width: bar.pushedX2 - bar.x2, top: bar.row * ROW_HEIGHT + 10, height: ROW_HEIGHT - 20 }}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => onSelect(task.id)}
                      title={[taskLabel(task), task.title, task.totalFloat !== null ? fill(copy.chart.floatDays, { days: task.totalFloat }) : '']
                        .filter(Boolean)
                        .join(' · ')}
                      aria-label={task.title + conflictNote}
                      className={cn(
                        'absolute overflow-hidden rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        barClass(conflict, critical),
                        selectedId === task.id && 'outline outline-2 outline-offset-1 outline-foreground',
                      )}
                      style={{ left: bar.x1, width: bar.x2 - bar.x1, top: bar.row * ROW_HEIGHT + 10, height: ROW_HEIGHT - 20 }}
                    >
                      <span
                        aria-hidden
                        className={cn('block h-full', critical ? 'bg-orange-700' : 'bg-blue-600')}
                        style={{ width: `${task.done ? 100 : progress}%` }}
                      />
                    </button>
                  </div>
                );
              })}

              <svg aria-hidden className="pointer-events-none absolute inset-0" width={timeline.width} height={height}>
                {schedule.dependencies.map((link) => {
                  const from = bars.get(link.predecessorId);
                  const to = bars.get(link.successorId);
                  if (!from || !to) return null;
                  const path = arrowPath(link.type, from, to);
                  const conflict = conflictedLinks.has(link.id);
                  const critical = showCritical && criticalIds.has(link.predecessorId) && criticalIds.has(link.successorId);
                  const color = linkColor(conflict, critical);
                  const label = linkLabel(t.flowSchedule.linkTypes[link.type], link.type, link.lagDays);
                  const pointsRight = link.type === 'fs' || link.type === 'ss';
                  return (
                    <g key={link.id}>
                      <path d={path.d} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={conflict ? '4 3' : undefined} />
                      <path
                        d={pointsRight ? `M ${path.ax} ${path.ay} l -6 -4 v 8 z` : `M ${path.ax} ${path.ay} l 6 -4 v 8 z`}
                        fill={color}
                      />
                      {label && (
                        <text x={path.ax + (pointsRight ? -8 : 8)} y={rowCenter(bars.get(link.successorId)?.row ?? 0) - 7} fontSize={10} textAnchor={pointsRight ? 'end' : 'start'} fill={color}>
                          {label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              {goLiveDay !== null && schedule.goLive.date && (
                <div aria-hidden className="absolute top-0 border-l-2 border-dashed border-emerald-600" style={{ left: xOf(timeline, goLiveDay + 1), height }}>
                  <span className="absolute left-1 top-1 whitespace-nowrap rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {fill(copy.chart.goLive, { date: shortDate(schedule.goLive.date, locale) })}
                  </span>
                </div>
              )}
              {todayDay >= timeline.startDay && todayDay <= timeline.endDay && (
                <div aria-hidden className="absolute top-0 border-l border-foreground/70" style={{ left: xOf(timeline, todayDay), height }}>
                  <span className="absolute -top-4 left-1 text-[10px] text-muted-foreground">{copy.chart.today}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
