/**
 * WeldSign: everyone has signed. Goes to the sender, every signer and every
 * copy recipient, with the signed PDF attached when it is small enough and a
 * link otherwise (or as well).
 */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface SignCompletedEmailProps {
  title: string;
  /** Names (or emails) of everyone who signed, in signing order. */
  signers: string[];
  /** Whether the signed PDF is attached to this email. */
  attached: boolean;
  /** Where to download it: the signer's portal link, or the request in WeldSuite for the sender. */
  url?: string | null;
  /** The sender gets "Open the request" instead of "Download signed PDF". */
  forSender?: boolean;
}

export default defineTemplate<SignCompletedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldSign' },

  subject: (props, { locale }) => fill(emailStrings(locale).sign.completed.subject, { title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).sign.completed;
    const url = props.url?.trim() || undefined;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { title: props.title })} footer={t.footer}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{props.title}</Heading>
        <Paragraph>{props.attached ? t.attached : t.download}</Paragraph>
        <Details rows={[{ label: t.signers, value: props.signers.join(', ') }]} />
        {url ? (
          <>
            <Actions>
              <Button accent={accentOf(brand)} href={url}>
                {props.forSender ? t.open : t.button}
              </Button>
            </Actions>
            {props.forSender ? null : <LinkFallback label={emailStrings(locale).layout.linkFallback} href={url} />}
          </>
        ) : null}
      </EmailLayout>
    );
  },

  previews: {
    attachedForSigner: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#4f46e5' },
      props: {
        title: 'Service agreement 2027',
        signers: ['Ann de Vries', 'Bob Smith'],
        attached: true,
        url: 'https://sign.weldsuite.org/r/abc123',
      },
    },
    linkOnly: {
      brand: { kind: 'workspace', name: 'Acme Staffing' },
      props: { title: 'Large contract', signers: ['Ann de Vries'], attached: false, url: 'https://sign.weldsuite.org/r/def456' },
    },
    forSender: {
      props: {
        title: 'Service agreement 2027',
        signers: ['Ann de Vries', 'Bob Smith'],
        attached: true,
        url: 'https://app.weldsuite.org/w/acme/weldsign/sgn_1',
        forSender: true,
      },
    },
  },
});
