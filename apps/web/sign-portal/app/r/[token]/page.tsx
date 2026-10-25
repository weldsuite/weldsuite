import { SIGN_DISCLOSURE_VERSION } from '@weldsuite/app-api-client/schemas/weldsign';
import { SigningFlow } from '@/components/signing-flow';
import { getServerI18n } from '@/lib/server-i18n';

/**
 * A signer's personal link, `/r/<token>`. The server component stays thin: it
 * picks the first-paint language and the disclosure version (imported here so
 * the schema package never ships to the browser); everything else is the
 * client flow in `components/signing-flow.tsx`.
 */
export default async function SigningLinkPage({ params }: Readonly<{ params: Promise<{ token: string }> }>) {
  const { token } = await params;
  const { locale } = await getServerI18n();
  return <SigningFlow token={token} initialLocale={locale} disclosureVersion={SIGN_DISCLOSURE_VERSION} />;
}
