/** Admin console: a workspace was scheduled for deletion, or that was cancelled. */

import { Details, EmailLayout, Heading, Kicker, Paragraph, Strong } from '../../components';
import { defineTemplate } from '../../define';
import { formatWhen } from '../../format';
import { emailStrings, fill, rich } from '../../i18n';

export interface WorkspaceDeletionEmailProps {
  kind: 'scheduled' | 'cancelled';
  workspaceName: string;
  /** ISO date-time of the deletion (scheduled mail). */
  deletionAt?: string | null;
  reason?: string | null;
}

export default defineTemplate<WorkspaceDeletionEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).deletion[props.kind].subject, { workspace: props.workspaceName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).deletion;
    const date = props.deletionAt ? formatWhen({ start: props.deletionAt, locale, timeZone: 'UTC' }) : '';
    const workspace = <Strong>{props.workspaceName}</Strong>;

    if (props.kind === 'cancelled') {
      return (
        <EmailLayout brand={brand} locale={locale} preview={fill(t.cancelled.preview, { workspace: props.workspaceName })}>
          <Kicker>{t.cancelled.kicker}</Kicker>
          <Heading>{props.workspaceName}</Heading>
          <Paragraph>{rich(t.cancelled.body, { workspace })}</Paragraph>
        </EmailLayout>
      );
    }

    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.scheduled.preview, { workspace: props.workspaceName, date })}
      >
        <Kicker>{t.scheduled.kicker}</Kicker>
        <Heading>{props.workspaceName}</Heading>
        <Paragraph>{rich(t.scheduled.body, { workspace, date: <Strong>{date}</Strong> })}</Paragraph>
        <Details rows={[{ label: t.scheduled.reason, value: props.reason?.trim() || undefined }]} />
        <Paragraph>{t.scheduled.contact}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    scheduled: {
      props: {
        kind: 'scheduled',
        workspaceName: 'Acme Studio',
        deletionAt: '2026-11-04T00:00:00.000Z',
        reason: 'Unpaid invoices',
      },
    },
    cancelled: {
      props: { kind: 'cancelled', workspaceName: 'Acme Studio' },
    },
  },
});
