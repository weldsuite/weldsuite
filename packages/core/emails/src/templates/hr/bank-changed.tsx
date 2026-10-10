/**
 * WeldHR payroll: the bank details salaries are paid to were changed. Changed
 * bank details are the classic payroll fraud, so the employee is always told,
 * whoever made the change. Never carries the account number.
 */

import { EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { formatDate, formatTime, zoneOr } from '../../format';
import { emailStrings, fill } from '../../i18n';

export interface HrBankChangedEmailProps {
  recipientName?: string | null;
  employerName: string;
  /** True when the employee changed them themselves (My HR or the portal), false when HR did. */
  byEmployee: boolean;
  /** ISO timestamp of the change. */
  changedAt: string;
  timeZone?: string | null;
}

export default defineTemplate<HrBankChangedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldHR' },

  subject: (_props, { locale }) => emailStrings(locale).hrBank.subject,

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).hrBank;
    const name = props.recipientName?.trim();
    const zone = zoneOr(props.timeZone);
    const when = `${formatDate(props.changedAt, locale, zone)}, ${formatTime(props.changedAt, locale, zone, true)}`;
    return (
      <EmailLayout brand={brand} locale={locale} preview={t.preview}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{t.heading}</Heading>
        <Paragraph>{name ? fill(t.greeting, { name }) : t.greetingNoName}</Paragraph>
        <Paragraph>{fill(props.byEmployee ? t.byYou : t.byHr, { employer: props.employerName, when })}</Paragraph>
        <Paragraph>{t.notYou}</Paragraph>
        <Paragraph muted>{t.privacy}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    byHr: {
      props: { recipientName: 'Lisa', employerName: 'Acme B.V.', byEmployee: false, changedAt: '2026-07-20T09:30:00Z', timeZone: 'Europe/Amsterdam' },
    },
    byYouWhiteLabel: {
      brand: { kind: 'workspace', name: 'Acme Staffing', poweredBy: false },
      props: { employerName: 'Acme Staffing B.V.', byEmployee: true, changedAt: '2026-07-20T09:30:00Z' },
    },
  },
});
