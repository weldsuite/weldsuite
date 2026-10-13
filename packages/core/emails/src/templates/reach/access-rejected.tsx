/** WeldReach: WeldSuite staff could not approve a workspace's access request. */

import { Actions, Button, EmailLayout, Heading, Kicker, MultilineText, Paragraph, Quote } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface ReachAccessRejectedEmailProps {
  recipientName?: string | null;
  workspaceName: string;
  /** Why, as written by the reviewer. */
  reason: string;
  /** The app store page of WeldReach, where the request can be filed again. Omitted: no button. */
  url?: string | null;
}

export default defineTemplate<ReachAccessRejectedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldReach' },

  subject: (props, { locale }) => fill(emailStrings(locale).reachRejected.subject, { workspace: props.workspaceName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).reachRejected;
    const name = props.recipientName?.trim();
    const url = props.url?.trim() || undefined;
    return (
      <EmailLayout brand={brand} locale={locale} preview={t.preview}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{t.heading}</Heading>
        <Paragraph>{name ? fill(t.greeting, { name }) : t.greetingNoName}</Paragraph>
        <Paragraph>{fill(t.body, { workspace: props.workspaceName })}</Paragraph>
        <Quote label={t.reason}>
          <MultilineText text={props.reason.trim()} />
        </Quote>
        <Paragraph>{t.again}</Paragraph>
        {url ? (
          <Actions>
            <Button accent={accentOf(brand)} href={url}>{t.open}</Button>
          </Actions>
        ) : null}
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        recipientName: 'Lisa',
        workspaceName: 'Acme Studio',
        reason: 'We could not verify that the contact lists come from your own customers.\nPlease describe where they come from and ask again.',
        url: 'https://app.weldsuite.org/appstore/weldreach',
      },
    },
    noNameNoLink: {
      props: {
        workspaceName: 'Acme Studio',
        reason: 'Outreach to consumers is not supported.',
      },
    },
  },
});
