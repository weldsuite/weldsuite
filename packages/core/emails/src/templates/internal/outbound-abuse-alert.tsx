/**
 * Internal: the outbound mail guard opened a case (a cold-outreach template, a
 * phishing verdict, a bounce or complaint spike, a high risk score) or tripped
 * the platform budget. Sent to WeldSuite staff, who review it in the admin
 * console. See docs/plans/weldmail-outbound-abuse.md.
 */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, MultilineText, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface OutboundAbuseAlertEmailProps {
  /** `cold_outreach_template | phishing | bounce_rate | complaints | risk_score | platform_budget | staff_review`. */
  trigger: string;
  severity: 'info' | 'warning' | 'urgent';
  /** One sentence: what happened. */
  summary: string;
  /** Null for the platform-wide budget alert. */
  workspaceName?: string | null;
  workspaceId?: string | null;
  riskScore?: number | null;
  /** Sending state after the automatic action, e.g. `restricted`. */
  state?: string | null;
  /** e.g. "cold_outreach (0.92)". */
  verdict?: string | null;
  templateSubject?: string | null;
  /** Normalised template text, at most 300 characters. */
  snippet?: string | null;
  firstContactRecipients?: number | null;
  sources?: string[];
  domains?: string[];
  /** The case in the admin console. */
  reviewUrl: string;
}

export default defineTemplate<OutboundAbuseAlertEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).outboundAlert;
    const triggers: Record<string, string> = t.triggers;
    return fill(t.subject, {
      severity: t.severities[props.severity],
      trigger: triggers[props.trigger] ?? props.trigger,
      workspace: props.workspaceName ?? 'WeldSuite',
    });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).outboundAlert;
    const triggers: Record<string, string> = t.triggers;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { summary: props.summary })}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{triggers[props.trigger] ?? props.trigger}</Heading>
        <Paragraph>{props.summary}</Paragraph>
        <Details
          rows={[
            { label: t.workspace, value: props.workspaceName || undefined },
            { label: t.workspaceId, value: props.workspaceId || undefined },
            { label: t.severity, value: t.severities[props.severity] },
            { label: t.riskScore, value: props.riskScore != null ? String(props.riskScore) : undefined },
            { label: t.state, value: props.state || undefined },
            { label: t.verdict, value: props.verdict || undefined },
            { label: t.templateSubject, value: props.templateSubject || undefined },
            {
              label: t.recipients,
              value: props.firstContactRecipients != null ? String(props.firstContactRecipients) : undefined,
            },
            { label: t.sources, value: props.sources?.length ? props.sources.join(', ') : undefined },
            { label: t.domains, value: props.domains?.length ? props.domains.join(', ') : undefined },
          ]}
        />
        {props.snippet ? (
          <Paragraph muted>
            <MultilineText text={props.snippet} />
          </Paragraph>
        ) : null}
        <Actions>
          <Button accent={accentOf(brand)} href={props.reviewUrl}>{t.review}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.reviewUrl} />
      </EmailLayout>
    );
  },

  previews: {
    coldOutreach: {
      props: {
        trigger: 'cold_outreach_template',
        severity: 'warning',
        summary: 'A template was classified as cold outreach and reached 31 first-contact recipients today.',
        workspaceName: 'Acme Studio',
        workspaceId: 'ws_123',
        riskScore: 58,
        state: 'active',
        verdict: 'cold_outreach (0.91)',
        templateSubject: 'Quick question about tokname',
        snippet: 'hi tokname i came across tokname and noticed you are hiring would you be open to a toknum minute call next week',
        firstContactRecipients: 31,
        sources: ['crm_sequence'],
        domains: ['example.com', 'example.org', 'example.net'],
        reviewUrl: 'https://admin.weldsuite.org/outbound-mail',
      },
    },
    phishing: {
      props: {
        trigger: 'phishing',
        severity: 'urgent',
        summary: 'A template was classified as phishing or a scam. New conversations are on hold.',
        workspaceName: 'Globex',
        workspaceId: 'ws_456',
        riskScore: 100,
        state: 'hold',
        verdict: 'phishing_or_scam (0.95)',
        templateSubject: 'Your account will be suspended',
        firstContactRecipients: 12,
        sources: ['api'],
        reviewUrl: 'https://admin.weldsuite.org/outbound-mail',
      },
    },
    platformBudget: {
      props: {
        trigger: 'platform_budget',
        severity: 'urgent',
        summary: 'Customer mail used 70% of the Cloudflare account quota today. First-contact sends stop until midnight UTC.',
        reviewUrl: 'https://admin.weldsuite.org/outbound-mail',
      },
    },
  },
});
