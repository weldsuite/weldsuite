/** WeldPanel: a raw export failed several times in a row and is marked as failing. Sent to the member who set it up. */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface PanelExportFailingEmailProps {
  exportName: string;
  projectName: string;
  /** The destination bucket (and prefix), as the customer set it. */
  bucket: string;
  /** Consecutive failed attempts. */
  failures: number;
  /** What the store answered last, as it said it. */
  lastError: string | null;
  /** Absolute link to the exports page. */
  url: string;
}

export default defineTemplate<PanelExportFailingEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldPanel' },

  subject: (props, { locale }) => fill(emailStrings(locale).panel.exportFailing.subject, { name: props.exportName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).panel.exportFailing;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.heading, { name: props.exportName })} footer={t.footer}>
        <Kicker>{fill(t.kicker, { project: props.projectName })}</Kicker>
        <Heading>{fill(t.heading, { name: props.exportName })}</Heading>
        <Paragraph>{fill(t.body, { count: props.failures, bucket: props.bucket })}</Paragraph>
        <Details rows={[{ label: t.error, value: props.lastError ?? '' }]} />
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>
            {t.button}
          </Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        exportName: 'Events to S3',
        projectName: 'Shop',
        bucket: 'acme-analytics/weldpanel',
        failures: 3,
        lastError: 'AccessDenied: Access Denied',
        url: 'https://app.weldsuite.org/settings/apps/weldpanel?tab=exports',
      },
    },
    noError: {
      props: {
        exportName: 'Daily people',
        projectName: 'App',
        bucket: 'warehouse-raw',
        failures: 3,
        lastError: null,
        url: 'https://app.weldsuite.org/settings/apps/weldpanel?tab=exports',
      },
    },
  },
});
