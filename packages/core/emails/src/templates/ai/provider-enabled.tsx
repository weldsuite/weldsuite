/**
 * AI settings (EU and self-hosted editions, ADR AI-012): an admin enabled an AI
 * provider outside the EU for the workspace. Sent to the workspace owners, who
 * should know where their data can go. Never carries a key.
 */

import { accentOf } from '../../brand';
import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface AiProviderEnabledEmailProps {
  recipientName?: string | null;
  workspaceName: string;
  /** Display name of the provider, e.g. "Anthropic" or "OpenAI". */
  providerName: string;
  /** Who enabled it: a name, or an email address when there is no name. */
  enabledBy: string;
  /** `weldsuite` = WeldSuite's account, charged as AI credits; `own` = the workspace's own key. */
  keySource: 'weldsuite' | 'own';
  /** The AI settings page, `/settings/ai` on the workspace's platform. */
  settingsUrl: string;
}

export default defineTemplate<AiProviderEnabledEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).aiProvider.subject, { provider: props.providerName, workspace: props.workspaceName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).aiProvider;
    const name = props.recipientName?.trim();
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { provider: props.providerName })}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{fill(t.heading, { provider: props.providerName })}</Heading>
        <Paragraph>{name ? fill(t.greeting, { name }) : t.greetingNoName}</Paragraph>
        <Paragraph>
          {fill(t.body, { who: props.enabledBy, provider: props.providerName, workspace: props.workspaceName })}
        </Paragraph>
        <Details
          rows={[
            { label: t.provider, value: props.providerName },
            { label: t.region, value: t.outsideEu },
            { label: t.keySource, value: props.keySource === 'own' ? t.keyOwn : t.keyWeldsuite },
            { label: t.enabledBy, value: props.enabledBy },
          ]}
        />
        <Paragraph muted>{t.note}</Paragraph>
        <Actions>
          <Button accent={accentOf(brand)} href={props.settingsUrl}>{t.open}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.settingsUrl} />
      </EmailLayout>
    );
  },

  previews: {
    weldsuiteAccount: {
      props: {
        recipientName: 'Lisa',
        workspaceName: 'Acme Studio',
        providerName: 'Anthropic',
        enabledBy: 'Tom Jansen',
        keySource: 'weldsuite',
        settingsUrl: 'https://app.acme.example/settings/ai',
      },
    },
    ownKey: {
      props: {
        workspaceName: 'Acme Studio',
        providerName: 'OpenAI',
        enabledBy: 'tom@acme.example',
        keySource: 'own',
        settingsUrl: 'https://app.acme.example/settings/ai',
      },
    },
  },
});
