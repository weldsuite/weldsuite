/**
 * Internal: an enterprise inquiry from the pricing dialog, sent to sales. The
 * sender sets Reply-To to the prospect.
 */

import { Details, EmailLayout, Heading, Kicker, MultilineText, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface EnterpriseInquiryEmailProps {
  companyName: string;
  teamSize: string;
  contactName: string;
  contactEmail: string;
  useCase?: string | null;
  source?: string | null;
  workspaceId?: string | null;
  orgId: string;
  userId: string;
  planSlug?: string | null;
}

export default defineTemplate<EnterpriseInquiryEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).enterprise.subject, { company: props.companyName, size: props.teamSize }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).enterprise;
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.subject, { company: props.companyName, size: props.teamSize })}
      >
        <Kicker>{t.kicker}</Kicker>
        <Heading>{props.companyName}</Heading>
        <Details
          rows={[
            { label: t.teamSize, value: props.teamSize },
            { label: t.contact, value: props.contactName },
            { label: t.email, value: props.contactEmail },
            { label: t.source, value: props.source || 'unknown' },
            { label: t.workspace, value: props.workspaceId || '—' },
            { label: t.org, value: props.orgId },
            { label: t.user, value: props.userId },
            { label: t.plan, value: props.planSlug || '—' },
          ]}
        />
        {props.useCase?.trim() ? (
          <>
            <Paragraph muted>{t.useCase}</Paragraph>
            <Paragraph>
              <MultilineText text={props.useCase.trim()} />
            </Paragraph>
          </>
        ) : null}
        <Paragraph muted>{fill(t.replyHint, { contact: props.contactName })}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        companyName: 'Globex Corporation',
        teamSize: '200-500',
        contactName: 'Hank Scorpio',
        contactEmail: 'hank@globex.example',
        useCase: 'Replace our CRM, helpdesk and project tool for 300 people.\nNeed SSO and EU data residency.',
        source: 'pricing-dialog',
        workspaceId: 'ws_123',
        orgId: 'org_abc',
        userId: 'user_def',
        planSlug: 'business',
      },
    },
  },
});
