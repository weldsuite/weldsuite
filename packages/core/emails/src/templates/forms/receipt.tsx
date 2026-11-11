/**
 * WeldForms: a copy of the respondent's own answers. Only ever sent to an
 * address that was verified (a code, or an invitation); the sender skips
 * fields the author marked sensitive.
 */

import { Details, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface FormsReceiptEmailProps {
  /** The form's title. */
  title: string;
  /** The response's number, when it has one. */
  number?: number | null;
  /** Question and answer as text, in form order. */
  answers: Array<{ question: string; answer: string }>;
}

export default defineTemplate<FormsReceiptEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldForms' },

  subject: (props, { locale }) => fill(emailStrings(locale).forms.receipt.subject, { title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).forms.receipt;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { title: props.title })} footer={t.footer}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{props.title}</Heading>
        <Paragraph>{t.body}</Paragraph>
        <Details rows={props.answers.map((a) => ({ label: a.question, value: a.answer }))} />
        {props.number ? <Paragraph muted>{fill(t.reference, { number: props.number })}</Paragraph> : null}
      </EmailLayout>
    );
  },

  previews: {
    default: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#4f46e5' },
      props: {
        title: 'Customer feedback',
        number: 42,
        answers: [
          { question: 'Your name', answer: 'Ann de Vries' },
          { question: 'Which plan?', answer: 'Pro' },
          { question: 'Anything else?', answer: 'Great service.' },
        ],
      },
    },
  },
});
