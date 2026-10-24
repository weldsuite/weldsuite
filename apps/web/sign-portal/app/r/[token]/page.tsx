import { MessageScreen } from '@/components/message-screen';
import { getServerI18n } from '@/lib/server-i18n';

/**
 * A signer's personal link, `/r/<token>`. Phase 2 of docs/plans/weldsign.md
 * exchanges the token for a signer session here (`POST /session`) and shows
 * the document; until then every link shows the not-available state.
 */
export default async function SigningLinkPage() {
  const { t } = await getServerI18n();
  return <MessageScreen title={t.link.title} body={t.link.body} footer={t.poweredBy} />;
}
