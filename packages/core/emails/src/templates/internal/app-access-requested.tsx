/**
 * Internal: a workspace asked for access to an app that is on request only
 * (WeldReach first). Sent to WeldSuite staff, who review it in the admin
 * console.
 */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, MultilineText, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill, intlLocale } from '../../i18n';

/** Countries where business addresses also need prior consent (mirrors `WELDREACH_CONSENT_COUNTRIES`). */
const CONSENT_COUNTRIES = ['NL', 'DE'];

export interface AppAccessRequestedEmailProps {
  /** Display name of the app, e.g. "WeldReach". */
  appName: string;
  workspaceName: string;
  workspaceId?: string | null;
  companyName: string;
  website: string;
  contactName: string;
  contactEmail: string;
  /** ISO 3166-1 alpha-2 codes. */
  targetCountries: string[];
  expectedDailySends: number;
  /** `own_customers | own_research | bought_list | other`; unknown values are shown as they are. */
  listSource: string;
  listSourceDetails?: string | null;
  useCase: string;
  termsVersion?: string | null;
  /** The request in the admin console. */
  reviewUrl: string;
}

export default defineTemplate<AppAccessRequestedEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).appAccess.subject, { app: props.appName, workspace: props.workspaceName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).appAccess;
    const sources: Record<string, string> = t.listSources;
    const countries = props.targetCountries.map((c) => c.toUpperCase());
    const consent = countries.filter((c) => CONSENT_COUNTRIES.includes(c));
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, { company: props.companyName, app: props.appName })}
      >
        <Kicker>{fill(t.kicker, { app: props.appName })}</Kicker>
        <Heading>{props.companyName}</Heading>
        <Details
          rows={[
            { label: t.workspace, value: props.workspaceName },
            { label: t.workspaceId, value: props.workspaceId || undefined },
            { label: t.website, value: props.website },
            { label: t.contact, value: props.contactName },
            { label: t.email, value: props.contactEmail },
            { label: t.countries, value: countries.join(', ') },
            {
              label: t.consent,
              value: consent.length ? fill(t.consentValue, { countries: consent.join(', ') }) : undefined,
            },
            { label: t.volume, value: props.expectedDailySends.toLocaleString(intlLocale(locale)) },
            { label: t.listSource, value: sources[props.listSource] ?? props.listSource },
            { label: t.listSourceDetails, value: props.listSourceDetails?.trim() || undefined },
            { label: t.terms, value: props.termsVersion || undefined },
          ]}
        />
        <Paragraph muted>{t.useCase}</Paragraph>
        <Paragraph>
          <MultilineText text={props.useCase.trim()} />
        </Paragraph>
        <Actions>
          <Button accent={accentOf(brand)} href={props.reviewUrl}>{t.review}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.reviewUrl} />
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        appName: 'WeldReach',
        workspaceName: 'Acme Studio',
        workspaceId: 'ws_123',
        companyName: 'Acme Studio B.V.',
        website: 'https://acme.example',
        contactName: 'Lisa de Vries',
        contactEmail: 'lisa@acme.example',
        targetCountries: ['BE', 'FR'],
        expectedDailySends: 200,
        listSource: 'own_customers',
        useCase: 'We email past customers about our new service tier.\nOnly people who bought from us in the last two years.',
        termsVersion: 'weldreach-2026-10',
        reviewUrl: 'https://admin.weldsuite.org/access-requests',
      },
    },
    consentCountriesBoughtList: {
      props: {
        appName: 'WeldReach',
        workspaceName: 'Globex',
        companyName: 'Globex Corporation',
        website: 'https://globex.example',
        contactName: 'Hank Scorpio',
        contactEmail: 'hank@globex.example',
        targetCountries: ['NL', 'DE', 'us'],
        expectedDailySends: 12000,
        listSource: 'bought_list',
        listSourceDetails: 'Purchased from a data vendor in March, opt-in status unknown.',
        useCase: 'Cold outreach to facility managers about our maintenance contracts.',
        reviewUrl: 'https://admin.weldsuite.org/access-requests',
      },
    },
  },
});
