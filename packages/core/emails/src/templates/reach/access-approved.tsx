/** WeldReach: WeldSuite staff approved a workspace's access request. */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill, intlLocale } from '../../i18n';

export interface ReachAccessApprovedEmailProps {
  recipientName?: string | null;
  workspaceName: string;
  /** Where WeldReach opens, e.g. https://app.weldsuite.org/weldreach. */
  url: string;
  /** The limits staff set. All three must be present for the sentence to show. */
  limits?: { maxDomains: number; maxMailboxes: number; maxDailySends: number } | null;
}

export default defineTemplate<ReachAccessApprovedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldReach' },

  subject: (props, { locale }) => fill(emailStrings(locale).reachApproved.subject, { workspace: props.workspaceName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).reachApproved;
    const name = props.recipientName?.trim();
    const number = (n: number) => n.toLocaleString(intlLocale(locale));
    return (
      <EmailLayout brand={brand} locale={locale} preview={t.preview}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{t.heading}</Heading>
        <Paragraph>{name ? fill(t.greeting, { name }) : t.greetingNoName}</Paragraph>
        <Paragraph>{fill(t.body, { workspace: props.workspaceName })}</Paragraph>
        {props.limits ? (
          <Paragraph>
            {fill(t.limits, {
              domains: number(props.limits.maxDomains),
              mailboxes: number(props.limits.maxMailboxes),
              sends: number(props.limits.maxDailySends),
            })}
          </Paragraph>
        ) : null}
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>{t.open}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.url} />
        <Paragraph muted>{t.terms}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        recipientName: 'Lisa',
        workspaceName: 'Acme Studio',
        url: 'https://app.weldsuite.org/weldreach',
        limits: { maxDomains: 3, maxMailboxes: 10, maxDailySends: 300 },
      },
    },
    noNameNoLimits: {
      props: {
        workspaceName: 'Acme Studio',
        url: 'https://app.weldsuite.org/weldreach',
      },
    },
  },
});
