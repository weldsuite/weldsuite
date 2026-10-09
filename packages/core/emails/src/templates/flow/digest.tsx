/**
 * WeldFlow daily task digest: overdue, due today and due this week. Carries
 * the workspace's logo and color, like the digest always has; the sender adds
 * the List-Unsubscribe headers.
 */

import { Actions, Button, EmailLayout, Heading, Kicker, List, Paragraph, TextLink } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { formatDate, zoneOr } from '../../format';
import { emailStrings, fill, intlLocale, type EmailLocale } from '../../i18n';

export interface DigestTask {
  title: string;
  projectName?: string | null;
  /** Personal (standalone) task rather than a project task. */
  personal?: boolean;
  /** ISO date-time. */
  dueDate?: string | null;
  /** Absolute link that opens the task (`/weldflow/task/{id}`). */
  url?: string | null;
}

export interface FlowDigestEmailProps {
  firstName: string;
  workspaceName: string;
  overdue: DigestTask[];
  dueToday: DigestTask[];
  dueThisWeek: DigestTask[];
  /** IANA zone of the workspace; dates are shown in it. */
  timezone?: string | null;
  /** The digest's date (ISO). Defaults to now. */
  date?: string | null;
  tasksUrl: string;
  settingsUrl?: string | null;
}

/** "Oct 5" / "5 okt". */
function shortDate(iso: string, locale: EmailLocale, timeZone: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'short', day: 'numeric', timeZone }).format(new Date(iso));
}

export default defineTemplate<FlowDigestEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldFlow' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).digest;
    const total = props.overdue.length + props.dueToday.length + props.dueThisWeek.length;
    return props.overdue.length > 0
      ? fill(t.subject.overdue, { count: props.overdue.length })
      : fill(t.subject.upcoming, { count: total });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).digest;
    const zone = zoneOr(props.timezone);
    const items = (tasks: DigestTask[]) =>
      tasks.map((task) => ({
        primary: task.title,
        href: task.url ?? undefined,
        secondary: task.projectName?.trim() || (task.personal ? t.personal : undefined),
        aside: task.dueDate ? shortDate(task.dueDate, locale, zone) : undefined,
      }));
    const section = (label: string, tasks: DigestTask[]) => `${label} · ${tasks.length}`;

    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, {
          overdue: props.overdue.length,
          today: props.dueToday.length,
          week: props.dueThisWeek.length,
        })}
        footer={
          <>
            {fill(t.footer, { workspace: props.workspaceName })}
            {props.settingsUrl ? ' · ' : null}
            {props.settingsUrl ? <TextLink href={props.settingsUrl} muted>{t.manage}</TextLink> : null}
          </>
        }
      >
        <Kicker>{fill(t.kicker, { date: formatDate(props.date ?? new Date().toISOString(), locale, zone) })}</Kicker>
        <Heading>{t.heading}</Heading>
        <Paragraph>{fill(t.intro, { name: props.firstName })}</Paragraph>
        <List title={section(t.overdue, props.overdue)} items={items(props.overdue)} />
        <List title={section(t.today, props.dueToday)} items={items(props.dueToday)} />
        <List title={section(t.week, props.dueThisWeek)} items={items(props.dueThisWeek)} />
        <Actions>
          <Button accent={accent} href={props.tasksUrl}>{t.viewAll}</Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      brand: { kind: 'workspace', name: 'Acme Studio', accentColor: '#2563eb' },
      props: {
        firstName: 'Tom',
        workspaceName: 'Acme Studio',
        timezone: 'Europe/Amsterdam',
        date: '2026-10-05T06:00:00.000Z',
        overdue: [{ title: 'Send invoice to Globex', projectName: 'Finance', dueDate: '2026-10-02T15:00:00.000Z' }],
        dueToday: [
          { title: 'Review homepage copy', projectName: 'Website relaunch', dueDate: '2026-10-05T15:00:00.000Z' },
          { title: 'Book dentist', personal: true, dueDate: '2026-10-05T09:00:00.000Z' },
        ],
        dueThisWeek: [{ title: 'Prepare Q4 budget review', projectName: 'Finance', dueDate: '2026-10-09T15:00:00.000Z' }],
        tasksUrl: 'https://app.weldsuite.org/task',
        settingsUrl: 'https://app.weldsuite.org/settings/notifications',
      },
    },
  },
});
