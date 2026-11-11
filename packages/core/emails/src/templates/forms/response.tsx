/**
 * WeldForms: a new response, to a member subscribed to the form. Carries the
 * answers, or only a link when the form has sensitive fields.
 */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface FormsResponseEmailProps {
  /** The form's title. */
  title: string;
  number?: number | null;
  /** Who answered, when known (an address or a name). */
  respondent?: string | null;
  /** Question and answer as text; `null` sends only the link (the form has sensitive fields). */
  answers: Array<{ question: string; answer: string }> | null;
  /** The response in WeldSuite. */
  url: string;
}

export default defineTemplate<FormsResponseEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldForms' },

  subject: (props, { locale }) => fill(emailStrings(locale).forms.response.subject, { title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).forms.response;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { title: props.title })} footer={t.footer}>
        <Kicker>{props.respondent ? fill(t.kickerFrom, { respondent: props.respondent }) : t.kicker}</Kicker>
        <Heading>{props.title}</Heading>
        {props.answers ? <Details rows={props.answers.map((a) => ({ label: a.question, value: a.answer }))} /> : <Paragraph>{t.linkOnly}</Paragraph>}
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>
            {t.button}
          </Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    withAnswers: {
      props: {
        title: 'Customer feedback',
        number: 42,
        respondent: 'ann@example.com',
        answers: [
          { question: 'Your name', answer: 'Ann de Vries' },
          { question: 'Which plan?', answer: 'Pro' },
        ],
        url: 'https://app.weldsuite.org/w/org_1/weldforms/frm_1/results?tab=responses',
      },
    },
    linkOnly: {
      props: {
        title: 'Employee survey',
        number: 7,
        answers: null,
        url: 'https://app.weldsuite.org/w/org_1/weldforms/frm_2/results?tab=responses',
      },
    },
  },
});
