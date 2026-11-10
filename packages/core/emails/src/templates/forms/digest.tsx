/** WeldForms: the daily digest of a form's new responses, to members subscribed to the digest. */

import { Actions, Button, EmailLayout, Heading, Kicker, List, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface FormsDigestEmailProps {
  /** The form's title. */
  title: string;
  workspaceName: string;
  /** How many responses came in since the last digest. */
  count: number;
  /** The newest few; the rest sit behind the link. */
  responses: Array<{ number?: number | null; respondent?: string | null; summary?: string | null }>;
  /** The form's responses in WeldSuite. */
  url: string;
}

export default defineTemplate<FormsDigestEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldForms' },

  subject: (props, { locale }) => fill(emailStrings(locale).forms.digest.subject, { count: props.count, title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).forms.digest;
    const more = props.count - props.responses.length;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { count: props.count, title: props.title })} footer={fill(t.footer, { workspace: props.workspaceName })}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{props.title}</Heading>
        <Paragraph>{fill(t.intro, { count: props.count })}</Paragraph>
        <List
          title={`${t.latest} · ${props.responses.length}`}
          items={props.responses.map((r) => ({
            primary: r.respondent?.trim() || t.anonymous,
            secondary: r.summary?.trim() || undefined,
            aside: r.number ? `#${r.number}` : undefined,
          }))}
        />
        {more > 0 ? <Paragraph muted>{fill(t.more, { count: more })}</Paragraph> : null}
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
        title: 'Customer feedback',
        workspaceName: 'Acme Staffing',
        count: 14,
        responses: [
          { number: 14, respondent: 'ann@example.com', summary: 'Pro' },
          { number: 13, respondent: null, summary: 'Free' },
          { number: 12, respondent: 'bob@example.com', summary: 'Pro' },
        ],
        url: 'https://app.weldsuite.org/w/org_1/weldforms/frm_1/results?tab=responses',
      },
    },
  },
});
