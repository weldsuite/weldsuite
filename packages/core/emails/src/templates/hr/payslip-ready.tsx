/**
 * WeldHR payroll: a payslip is ready. Never carries pay figures; it only says
 * that the payslip exists and where to read it.
 */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { formatDate } from '../../format';
import { emailStrings, fill } from '../../i18n';

export interface HrPayslipReadyEmailProps {
  recipientName?: string | null;
  employerName: string;
  /** The pay date, `YYYY-MM-DD`. */
  payDate: string;
  /** Where to read it (My HR or the workforce portal). Omitted: the email only says it is ready. */
  url?: string | null;
}

export default defineTemplate<HrPayslipReadyEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldHR' },

  subject: (props, { locale }) => fill(emailStrings(locale).hrPayslip.subject, { employer: props.employerName }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).hrPayslip;
    const name = props.recipientName?.trim();
    const url = props.url?.trim() || undefined;
    const date = formatDate(`${props.payDate}T12:00:00Z`, locale, 'UTC');
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { employer: props.employerName })}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{t.heading}</Heading>
        <Paragraph>{name ? fill(t.greeting, { name }) : t.greetingNoName}</Paragraph>
        <Paragraph>{fill(t.body, { employer: props.employerName, date })}</Paragraph>
        {url ? (
          <>
            <Actions>
              <Button accent={accent} href={url}>{t.open}</Button>
            </Actions>
            <LinkFallback label={emailStrings(locale).layout.linkFallback} href={url} />
          </>
        ) : null}
        <Paragraph muted>{t.privacy}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        recipientName: 'Lisa',
        employerName: 'Acme B.V.',
        payDate: '2026-07-24',
        url: 'https://team.weldsuite.org/acme',
      },
    },
    noLinkWhiteLabel: {
      brand: { kind: 'workspace', name: 'Acme Staffing', poweredBy: false },
      props: { employerName: 'Acme Staffing B.V.', payDate: '2026-07-24' },
    },
  },
});
