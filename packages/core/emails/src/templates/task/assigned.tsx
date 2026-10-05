/** WeldFlow: a task was assigned to the recipient. */

import {
  Actions,
  Button,
  Details,
  EmailLayout,
  Heading,
  Kicker,
  MultilineText,
  Paragraph,
  Strong,
  TextLink,
} from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { formatDate, zoneOr } from '../../format';
import { emailStrings, fill, rich } from '../../i18n';

export interface TaskAssignedEmailProps {
  assignerName: string;
  taskTitle: string;
  projectName?: string | null;
  /** low | medium | high | urgent; anything else is shown as-is. */
  priority?: string | null;
  /** ISO date-time of the due date. */
  dueDate?: string | null;
  /** IANA zone the due date is shown in. */
  timezone?: string | null;
  description?: string | null;
  taskUrl: string;
  settingsUrl?: string | null;
}

export default defineTemplate<TaskAssignedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldFlow' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).task.subject, { assigner: props.assignerName, title: props.taskTitle }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).task;
    const n = emailStrings(locale).notifications;
    const priorityKey = props.priority?.trim().toLowerCase() as keyof typeof t.priorities | undefined;
    const priority = priorityKey && priorityKey in t.priorities ? t.priorities[priorityKey] : props.priority?.trim();
    const due = props.dueDate ? formatDate(props.dueDate, locale, zoneOr(props.timezone)) : undefined;

    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.subject, { assigner: props.assignerName, title: props.taskTitle })}
        footer={
          <>
            {n.footer}
            {props.settingsUrl ? ' · ' : null}
            {props.settingsUrl ? <TextLink href={props.settingsUrl} muted>{n.manage}</TextLink> : null}
          </>
        }
      >
        <Kicker>{rich(t.intro, { assigner: <Strong>{props.assignerName}</Strong> })}</Kicker>
        <Heading>{props.taskTitle}</Heading>
        <Details
          rows={[
            { label: t.project, value: props.projectName?.trim() || undefined },
            { label: t.priority, value: priority || undefined },
            { label: t.due, value: due },
          ]}
        />
        {props.description?.trim() ? (
          <Paragraph>
            <MultilineText text={props.description.trim()} />
          </Paragraph>
        ) : null}
        <Actions>
          <Button accent={accent} href={props.taskUrl}>{t.view}</Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    full: {
      props: {
        assignerName: 'Tom Jansen',
        taskTitle: 'Prepare Q4 budget review',
        projectName: 'Finance',
        priority: 'high',
        dueDate: '2026-10-16T15:00:00.000Z',
        timezone: 'Europe/Amsterdam',
        description: 'Collect the numbers from each team lead and draft the summary.',
        taskUrl: 'https://app.weldsuite.org/weldflow/tasks/123',
        settingsUrl: 'https://app.weldsuite.org/settings/notifications',
      },
    },
    minimal: {
      props: {
        assignerName: 'Tom Jansen',
        taskTitle: 'Call the supplier',
        taskUrl: 'https://app.weldsuite.org/weldflow/tasks/124',
      },
    },
  },
});
