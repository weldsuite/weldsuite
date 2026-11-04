/**
 * WeldFlow: a project status report was published (FLOW-018). Goes to the
 * project's stakeholders: workspace members (with the WeldSuite brand) and
 * CRM contacts with portal access (with the workspace brand). It carries the
 * overall status and the project manager's summary, and links to the full
 * report; the areas, risks and milestones stay on that page, which is the
 * frozen snapshot of what was reported.
 *
 * Kept flat (no lists) so the Rust backend sends the same mail from the
 * exported variants.
 */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, MultilineText, Paragraph, Status } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface FlowStatusReportEmailProps {
  /** Greeting name. Omitted: the email opens without one. */
  recipientName?: string | null;
  projectName: string;
  /** The period as the recipient reads it (`periodLabel(locale, '2026-W45')`: "Week 45, 2026"). */
  periodLabel: string;
  /** The overall colour of the report (`grey`, no data, is never published). */
  overall: 'green' | 'amber' | 'red';
  /** The project manager's summary; line breaks are kept. */
  summary: string;
  /** Who published the report. */
  publishedBy?: string | null;
  /** Absolute link to the report (the app for members, the portal for contacts). */
  url: string;
}

export default defineTemplate<FlowStatusReportEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldFlow' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).statusReport;
    return fill(t.subject, { project: props.projectName, period: props.periodLabel, status: t.status[props.overall] });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).statusReport;
    const name = props.recipientName?.trim();
    const by = props.publishedBy?.trim();
    const status = t.status[props.overall];
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, { project: props.projectName, status, period: props.periodLabel })}
        footer={fill(t.footer, { project: props.projectName })}
      >
        <Kicker>{fill(t.kicker, { period: props.periodLabel })}</Kicker>
        <Heading>{props.projectName}</Heading>
        <Paragraph>{name ? fill(t.intro, { name }) : t.introNoName}</Paragraph>
        <Details rows={[{ label: t.statusLabel, value: <Status tone={props.overall}>{status}</Status> }]} />
        <Paragraph>
          <MultilineText text={props.summary} />
        </Paragraph>
        {by ? <Paragraph muted>{fill(t.publishedBy, { name: by })}</Paragraph> : null}
        <Actions>
          <Button accent={accent} href={props.url}>{t.view}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.url} />
      </EmailLayout>
    );
  },

  previews: {
    green: {
      props: {
        recipientName: 'Noor',
        projectName: 'Customer Portal Relaunch',
        periodLabel: 'Week 45, 2026',
        overall: 'green',
        summary: 'The catalogue API is done and the invoice pages started this week.\nGo-live on 15 January still holds.',
        publishedBy: 'Sanne Jansen',
        url: 'https://app.weldsuite.org/w/org_acme/weldflow/project/proj_1/governance',
      },
    },
    amber: {
      brand: { kind: 'workspace', name: 'Acme Studio', accentColor: '#2563eb' },
      props: {
        recipientName: 'Femke',
        projectName: 'Customer Portal Relaunch',
        periodLabel: 'Week 45, 2026',
        overall: 'amber',
        summary: 'The order history migration is the main concern: batch 1 starts on 9 November.',
        url: 'https://projects.weldsuite.org/ws_acme/projects/proj_1/reports/rpt_1',
      },
    },
    redNoName: {
      props: {
        projectName: 'Customer Portal Relaunch',
        periodLabel: 'November 2026',
        overall: 'red',
        summary: 'We need a decision on payment API v3 by Friday, otherwise deliverable D4 slips.',
        publishedBy: 'Sanne Jansen',
        url: 'https://app.weldsuite.org/w/org_acme/weldflow/project/proj_1/governance',
      },
    },
  },
});
