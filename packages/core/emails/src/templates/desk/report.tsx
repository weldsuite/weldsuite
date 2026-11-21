/**
 * WeldDesk: a report sent by email on a schedule (TASK-1228). Either the
 * overview (a table of the KPIs with their change against the previous
 * period, the backlog now and the top agents) or a saved report (one small
 * table per chart). The numbers arrive raw; the template formats them
 * (durations as `1h 30m`, one decimal for percentages, `+12%` changes) so the
 * Rust backend can mirror it from the same previews.
 */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, List, Paragraph, Status } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill, type EmailLocale, type EmailStrings } from '../../i18n';

export type DeskReportKpiKey = 'created' | 'resolved' | 'firstResponseMedian' | 'resolutionMedian' | 'slaCompliance' | 'csat';

export interface DeskReportKpi {
  key: DeskReportKpiKey;
  /** Whole counts, seconds (the two medians) or a percentage; null: no data in the period. */
  value: number | null;
  /** The same figure for the period just before. */
  previous: number | null;
}

export interface DeskReportChart {
  title: string;
  /** Up to 10 rows; an empty list reads as "no data". */
  rows: Array<{ label: string; value: number }>;
}

export interface DeskReportAgent {
  name: string;
  resolved: number;
  /** Percentage of ratings that were 4 or 5. */
  csat: number | null;
}

export interface DeskReportEmailProps {
  /** Name of the schedule, shown in the footer. */
  scheduleName: string;
  /** Title of the saved report. Omitted or null: the overview. */
  reportTitle?: string | null;
  /** The period as the recipient reads it ("Mar 9 to Mar 15, 2026"); for a saved report the day it was sent. */
  periodLabel: string;
  /** Overview: the KPIs, in the order shown. */
  kpis?: DeskReportKpi[];
  /** Overview: the backlog now. */
  backlog?: { open: number; unassigned: number; waiting: number } | null;
  /** Overview: the top agents. */
  agents?: DeskReportAgent[];
  /** Saved report: its charts. */
  charts?: DeskReportChart[];
  /** Absolute link that opens the report in WeldDesk. */
  url: string;
  /** Name of the member who set the schedule up. */
  scheduledBy?: string | null;
  /** The numbers are also attached as a CSV file. */
  csvAttached?: boolean;
}

type KpiKind = 'count' | 'duration' | 'percent';

/** How a KPI is written, and which direction of change is an improvement (null: neither). */
const KPI_FORMAT: Record<DeskReportKpiKey, { kind: KpiKind; good: 'up' | 'down' | null }> = {
  created: { kind: 'count', good: null },
  resolved: { kind: 'count', good: 'up' },
  firstResponseMedian: { kind: 'duration', good: 'down' },
  resolutionMedian: { kind: 'duration', good: 'down' },
  slaCompliance: { kind: 'percent', good: 'up' },
  csat: { kind: 'percent', good: 'up' },
};

/** `12`, `12.5`; Dutch with a decimal comma. One decimal at most. */
export function formatReportNumber(value: number, locale: EmailLocale): string {
  const text = String(Math.round(value * 10) / 10);
  return locale === 'nl' ? text.replace('.', ',') : text;
}

/**
 * Seconds as `45s`, `12m`, `1h 30m` or `2d 3h`. From a minute up the
 * duration is rounded to whole minutes once and every unit is read from
 * that, so a unit never shows its own full count: 59m 30s is `1h`, not
 * `60m`, and 23h 59m 30s is `1d`, not `24h`.
 */
export function formatReportDuration(seconds: number, locale: EmailLocale): string {
  const u = emailStrings(locale).deskReport.units;
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}${u.second}`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}${u.minute}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}${u.hour} ${rest}${u.minute}` : `${hours}${u.hour}`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}${u.day} ${restHours}${u.hour}` : `${days}${u.day}`;
}

function formatKpi(kpi: DeskReportKpi, locale: EmailLocale): string {
  if (kpi.value === null) return emailStrings(locale).deskReport.noValue;
  const { kind } = KPI_FORMAT[kpi.key];
  if (kind === 'duration') return formatReportDuration(kpi.value, locale);
  if (kind === 'percent') return `${formatReportNumber(kpi.value, locale)}%`;
  return formatReportNumber(kpi.value, locale);
}

interface Change {
  text: string;
  tone: 'green' | 'red' | null;
}

/** The change against the previous period; null when either figure is missing. */
function changeOf(kpi: DeskReportKpi, t: EmailStrings['deskReport'], locale: EmailLocale): Change | null {
  if (kpi.value === null || kpi.previous === null) return null;
  const { kind, good } = KPI_FORMAT[kpi.key];
  let delta: number;
  let text: string;
  if (kind === 'percent') {
    delta = Math.round((kpi.value - kpi.previous) * 10) / 10;
    text = `${delta > 0 ? '+' : '-'}${formatReportNumber(Math.abs(delta), locale)} ${t.points}`;
  } else if (kpi.previous === 0) {
    delta = kpi.value === 0 ? 0 : 1;
    text = t.newValue;
  } else {
    const percent = Math.round(((kpi.value - kpi.previous) / kpi.previous) * 100);
    delta = percent;
    text = `${percent > 0 ? '+' : '-'}${Math.abs(percent)}%`;
  }
  if (delta === 0) return { text: t.noChange, tone: null };
  if (!good) return { text, tone: null };
  return { text, tone: delta > 0 === (good === 'up') ? 'green' : 'red' };
}

export default defineTemplate<DeskReportEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldDesk' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).deskReport;
    return fill(t.subject, { report: props.reportTitle?.trim() || t.overview, period: props.periodLabel });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).deskReport;
    const saved = !!props.reportTitle?.trim();
    const report = props.reportTitle?.trim() || t.overview;
    const by = props.scheduledBy?.trim();

    const kpiRows = (props.kpis ?? []).map((kpi) => {
      const change = changeOf(kpi, t, locale);
      return {
        label: t.kpi[kpi.key],
        value: (
          <>
            {formatKpi(kpi, locale)}
            {change ? (
              <>
                {' · '}
                {change.tone ? <Status tone={change.tone}>{change.text}</Status> : change.text}
              </>
            ) : null}
          </>
        ),
      };
    });

    const backlog = props.backlog;
    const agents = props.agents ?? [];

    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, { report, period: props.periodLabel })}
        footer={by ? fill(t.footer, { name: by, schedule: props.scheduleName }) : fill(t.footerNoName, { schedule: props.scheduleName })}
      >
        <Kicker>{fill(t.kicker, { period: props.periodLabel })}</Kicker>
        <Heading>{report}</Heading>
        <Paragraph>{saved ? t.introSaved : t.introOverview}</Paragraph>
        <Details rows={kpiRows} />
        {backlog ? (
          <List
            title={t.backlog}
            items={[
              { primary: t.backlogOpen, aside: String(backlog.open) },
              { primary: t.backlogUnassigned, aside: String(backlog.unassigned) },
              { primary: t.backlogWaiting, aside: String(backlog.waiting) },
            ]}
          />
        ) : null}
        <List
          title={t.agents}
          items={agents.map((agent) => ({
            primary: agent.name,
            secondary: fill(t.agentResolved, { count: agent.resolved }),
            aside: agent.csat === null ? undefined : `${t.csatShort} ${formatReportNumber(agent.csat, locale)}%`,
          }))}
        />
        {(props.charts ?? []).map((chart, i) =>
          chart.rows.length > 0 ? (
            <List
              key={i}
              title={chart.title}
              items={chart.rows.map((row) => ({ primary: row.label, aside: formatReportNumber(row.value, locale) }))}
            />
          ) : (
            <Paragraph key={i} muted>
              {fill(t.noData, { title: chart.title })}
            </Paragraph>
          ),
        )}
        <Actions>
          <Button accent={accent} href={props.url}>{t.open}</Button>
        </Actions>
        {props.csvAttached ? <Paragraph muted>{t.csvAttached}</Paragraph> : null}
      </EmailLayout>
    );
  },

  previews: {
    overview: {
      props: {
        scheduleName: 'Weekly team report',
        periodLabel: 'Mar 9 to Mar 15, 2026',
        kpis: [
          { key: 'created', value: 128, previous: 110 },
          { key: 'resolved', value: 119, previous: 101 },
          { key: 'firstResponseMedian', value: 1260, previous: 1800 },
          { key: 'resolutionMedian', value: 15300, previous: 14400 },
          { key: 'slaCompliance', value: 93.5, previous: 91.2 },
          { key: 'csat', value: 88.4, previous: 90 },
        ],
        backlog: { open: 42, unassigned: 7, waiting: 15 },
        agents: [
          { name: 'Ann de Vries', resolved: 38, csat: 92.5 },
          { name: 'Bob Jansen', resolved: 31, csat: null },
          { name: 'Chloe Smit', resolved: 24, csat: 85 },
        ],
        url: 'https://app.weldsuite.org/w/org_acme/welddesk/reports',
        scheduledBy: 'Sanne Jansen',
        csvAttached: true,
      },
    },
    overviewQuiet: {
      props: {
        scheduleName: 'Daily check',
        periodLabel: 'Mar 15, 2026',
        kpis: [
          { key: 'created', value: 0, previous: 0 },
          { key: 'resolved', value: 3, previous: 0 },
          { key: 'firstResponseMedian', value: null, previous: 600 },
          { key: 'resolutionMedian', value: null, previous: null },
          { key: 'slaCompliance', value: null, previous: null },
          { key: 'csat', value: null, previous: null },
        ],
        backlog: { open: 0, unassigned: 0, waiting: 0 },
        agents: [],
        url: 'https://app.weldsuite.org/welddesk/reports',
      },
    },
    saved: {
      props: {
        scheduleName: 'Monthly volume',
        reportTitle: 'Support volume by channel',
        periodLabel: 'Mar 15, 2026',
        charts: [
          {
            title: 'Tickets by channel',
            rows: [
              { label: 'email', value: 212 },
              { label: 'messenger', value: 96 },
              { label: 'phone', value: 18 },
            ],
          },
          { title: 'Average first response (minutes)', rows: [{ label: 'Mar 14', value: 21.5 }, { label: 'Mar 15', value: 17 }] },
          { title: 'Ratings distribution', rows: [] },
        ],
        url: 'https://app.weldsuite.org/w/org_acme/welddesk/reports/custom/rpt_1',
        scheduledBy: 'Sanne Jansen',
        csvAttached: true,
      },
    },
  },
});
