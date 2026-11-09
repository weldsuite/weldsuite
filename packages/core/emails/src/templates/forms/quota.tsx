/** WeldForms: the workspace has used 80 % or all of its monthly response quota. Sent to workspace admins. */

import { Actions, Button, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { formatDate } from '../../format';
import { emailStrings, fill } from '../../i18n';

export interface FormsQuotaEmailProps {
  workspaceName: string;
  /** 80 or 100. */
  percent: 80 | 100;
  used: number;
  limit: number;
  /** ISO time the quota resets (start of next month, UTC). */
  resetsAt: string;
  /** Where to look at plans. */
  url: string;
}

export default defineTemplate<FormsQuotaEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldForms' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).forms.quota;
    return fill(props.percent >= 100 ? t.subjectFull : t.subjectNear, { workspace: props.workspaceName });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).forms.quota;
    const full = props.percent >= 100;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(full ? t.previewFull : t.previewNear, { used: props.used, limit: props.limit })} footer={t.footer}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{fill(full ? t.headingFull : t.headingNear, { percent: props.percent })}</Heading>
        <Paragraph>{fill(t.usage, { used: props.used, limit: props.limit })}</Paragraph>
        <Paragraph>{full ? t.bodyFull : t.bodyNear}</Paragraph>
        <Paragraph muted>{fill(t.resets, { date: formatDate(props.resetsAt, locale, 'UTC') })}</Paragraph>
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>
            {t.button}
          </Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    near: { props: { workspaceName: 'Acme Staffing', percent: 80, used: 80, limit: 100, resetsAt: '2026-12-01T00:00:00.000Z', url: 'https://app.weldsuite.org/settings/billing' } },
    full: { props: { workspaceName: 'Acme Staffing', percent: 100, used: 100, limit: 100, resetsAt: '2026-12-01T00:00:00.000Z', url: 'https://app.weldsuite.org/settings/billing' } },
  },
});
