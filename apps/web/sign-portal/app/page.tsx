import { MessageScreen } from '@/components/message-screen';
import { getServerI18n } from '@/lib/server-i18n';

export default async function HomePage() {
  const { t } = await getServerI18n();
  return <MessageScreen title={t.home.title} body={t.home.body} footer={t.poweredBy} />;
}
